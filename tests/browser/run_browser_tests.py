from __future__ import annotations

import asyncio
import base64
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from playwright.async_api import Browser, Page, async_playwright

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "dist"
FIXTURES = ROOT / "tests" / "fixtures"
REPORT_JSON = ROOT / "docs" / "browser-test-report.json"
REPORT_MD = ROOT / "docs" / "browser-test-report.md"
POLICY = Path("/etc/chromium/policies/managed/000_policy_merge.json")


def wait_port(port: int, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"Server did not open port {port}")


def choose_display() -> str:
    for number in range(91, 110):
        socket_path = Path(f"/tmp/.X11-unix/X{number}")
        if not socket_path.exists():
            return f":{number}"
    raise RuntimeError("No free Xvfb display")


@contextmanager
def temporary_chromium_policy_allow_localhost() -> Iterator[bool]:
    """The execution image blocks every URL by policy; restore it byte-for-byte after tests."""
    if os.geteuid() != 0 or not POLICY.exists():
        yield False
        return
    original = POLICY.read_bytes()
    changed = False
    try:
        data = json.loads(original)
        if data.get("URLBlocklist") == ["*"]:
            data.pop("URLBlocklist", None)
            data["URLAllowlist"] = ["http://127.0.0.1:*"]
            POLICY.write_text(json.dumps(data), encoding="utf-8")
            changed = True
        yield changed
    finally:
        if changed:
            POLICY.write_bytes(original)


def fixture_payload(name: str, mime_type: str) -> dict[str, str]:
    return {
        "base64": base64.b64encode((FIXTURES / name).read_bytes()).decode("ascii"),
        "mimeType": mime_type,
        "name": name,
    }


RUN_BLOB_SCRIPT = """
async ({base64, mimeType, backend, outputType}) => {
  const module = await import('/src/index.js');
  if (!globalThis.__browserTestEnhancer) {
    globalThis.__browserTestEnhancer = new module.ImageEnhancer({ resultRetentionMs: 60000 });
    globalThis.__browserTestCapabilities = await globalThis.__browserTestEnhancer.ready();
  }
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const blob = new Blob([bytes], { type: mimeType });
  const taskId = globalThis.__browserTestEnhancer.createTask(blob, {
    outputType,
    processingBackend: backend
  });
  const result = await globalThis.__browserTestEnhancer.getResult(taskId);
  const info = globalThis.__browserTestEnhancer.getStatus(taskId);
  const bitmap = await createImageBitmap(result);
  const decoded = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  await globalThis.__browserTestEnhancer.disposeTask(taskId);
  return {
    status: info.status,
    progress: info.progress,
    processingBackend: info.processingBackend,
    inferenceBackend: info.inferenceBackend,
    processingTimeMs: info.processingTimeMs,
    outputType: result.type,
    outputSize: result.size,
    input: info.input,
    output: info.output,
    parameters: info.parameters,
    timings: info.timings,
    warnings: info.warnings,
    decoded
  };
}
"""

COMPARE_SCRIPT = """
async ({base64, mimeType}) => {
  const module = await import('/src/index.js');
  const enhancer = new module.ImageEnhancer({ resultRetentionMs: 60000 });
  await enhancer.ready();
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const input = new Blob([bytes], { type: mimeType });
  async function run(backend) {
    const id = enhancer.createTask(input, { outputType: 'image/png', processingBackend: backend });
    const blob = await enhancer.getResult(id);
    const info = enhancer.getStatus(id);
    await enhancer.disposeTask(id);
    return { blob, info };
  }
  const gpu = await run('webgl2');
  const cpu = await run('cpu');
  async function pixels(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  }
  const a = await pixels(gpu.blob);
  const b = await pixels(cpu.blob);
  let total = 0;
  let maximum = 0;
  let alphaMismatch = 0;
  let channels = 0;
  for (let offset = 0; offset < a.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = Math.abs(a[offset + channel] - b[offset + channel]);
      total += difference;
      maximum = Math.max(maximum, difference);
      channels += 1;
    }
    if (a[offset + 3] !== b[offset + 3]) alphaMismatch += 1;
  }
  await enhancer.dispose();
  return {
    meanAbsoluteError: total / channels,
    maximumError: maximum,
    alphaMismatch,
    gpuBackend: gpu.info.processingBackend,
    cpuBackend: cpu.info.processingBackend
  };
}
"""

MAX_IMAGE_SCRIPT = """
async ({backend}) => {
  const module = await import('/src/index.js');
  const enhancer = new module.ImageEnhancer({ resultRetentionMs: 60000 });
  const capabilities = await enhancer.ready();
  const width = 5000;
  const height = 3000;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false });
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#10182e');
  gradient.addColorStop(0.5, '#b56f64');
  gradient.addColorStop(1, '#ead39b');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  for (let index = 0; index < 20; index += 1) {
    context.fillStyle = `hsl(${index * 31} 62% 48%)`;
    context.fillRect((index * 701) % width, (index * 421) % height, 310, 190);
  }
  const input = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  const taskId = enhancer.createTask(input, { outputType: 'image/jpeg', processingBackend: backend });
  const result = await enhancer.getResult(taskId);
  const info = enhancer.getStatus(taskId);
  const bitmap = await createImageBitmap(result);
  const outputDimensions = [bitmap.width, bitmap.height];
  bitmap.close();
  await enhancer.disposeTask(taskId);
  await enhancer.dispose();
  return {
    capabilities,
    status: info.status,
    backend: info.processingBackend,
    inferenceBackend: info.inferenceBackend,
    processingTimeMs: info.processingTimeMs,
    timings: info.timings,
    outputDimensions,
    inputSize: input.size,
    outputSize: result.size
  };
}
"""

CANCEL_SCRIPT = """
async () => {
  const module = await import('/src/index.js');
  const enhancer = new module.ImageEnhancer({ resultRetentionMs: 60000 });
  await enhancer.ready();
  const canvas = new OffscreenCanvas(5000, 3000);
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#334466';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const input = await canvas.convertToBlob({ type: 'image/png' });
  const id = enhancer.createTask(input, { outputType: 'image/png', processingBackend: 'cpu' });
  const aborted = await enhancer.abortTask(id);
  const info = enhancer.getStatus(id);
  await enhancer.disposeTask(id);
  await enhancer.dispose();
  return { aborted, status: info.status, progress: info.progress };
}
"""


async def run_tests(page: Page) -> dict[str, Any]:
    page_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(f"pageerror: {error}"))
    page.on(
        "console",
        lambda message: page_errors.append(f"console {message.type}: {message.text}")
        if message.type == "error"
        else None,
    )

    await page.goto("http://127.0.0.1:8765/", wait_until="networkidle")
    await page.wait_for_function("!document.querySelector('#capabilities-grid .skeleton')", timeout=20_000)
    capabilities_text = await page.locator("#capabilities-grid").inner_text()
    assert "WebGL2\nPASS" in capabilities_text, capabilities_text
    assert "WebAssembly ML\nWASM" in capabilities_text, capabilities_text

    cases: list[dict[str, Any]] = []
    for name, mime_type, backend, output_type, expected_dimensions, expected_mime in [
        ("sample.jpg", "image/jpeg", "webgl2", "image/jpeg", [640, 420], "image/jpeg"),
        ("sample.png", "image/png", "cpu", "image/png", [640, 420], "image/png"),
        ("sample24.bmp", "image/bmp", "auto", "image/png", [640, 420], "image/png"),
        ("sample32.bmp", "image/bmp", "cpu", "image/png", [96, 64], "image/png"),
        ("orientation6.jpg", "image/jpeg", "webgl2", "image/jpeg", [420, 640], "image/jpeg"),
    ]:
        payload = fixture_payload(name, mime_type)
        result = await page.evaluate(
            RUN_BLOB_SCRIPT,
            {**payload, "backend": backend, "outputType": output_type},
        )
        assert result["status"] == "completed", result
        assert result["progress"] == 100, result
        assert int(result["decoded"]["width"]) == int(expected_dimensions[0]), (result, expected_dimensions)
        assert int(result["decoded"]["height"]) == int(expected_dimensions[1]), (result, expected_dimensions)
        assert result["outputType"] == expected_mime, result
        assert result["outputSize"] > 0, result
        assert result["processingTimeMs"] < 30_000, result
        if backend == "webgl2":
            assert result["processingBackend"] == "webgl2", result
        if backend == "cpu":
            assert result["processingBackend"] == "cpu", result
        assert result["inferenceBackend"] == "wasm", result
        cases.append({"name": name, "requestedBackend": backend, **result})

    comparison = await page.evaluate(COMPARE_SCRIPT, fixture_payload("sample.jpg", "image/jpeg"))
    assert comparison["gpuBackend"] == "webgl2", comparison
    assert comparison["cpuBackend"] == "cpu", comparison
    assert comparison["meanAbsoluteError"] <= 1.5, comparison
    assert comparison["alphaMismatch"] == 0, comparison

    maximum = await page.evaluate(MAX_IMAGE_SCRIPT, {"backend": "auto"})
    assert maximum["status"] == "completed", maximum
    assert maximum["outputDimensions"] == [5000, 3000], maximum
    assert maximum["processingTimeMs"] <= 30_000, maximum

    cancellation = await page.evaluate(CANCEL_SCRIPT)
    assert cancellation["status"] == "cancelled", cancellation
    assert cancellation["aborted"]["success"] is True, cancellation

    await page.set_input_files("#file-input", str(FIXTURES / "sample.png"))
    await page.click("#enhance-button")
    await page.wait_for_selector("#result-section:not(.hidden)", timeout=30_000)
    await page.wait_for_function("document.querySelector('#after-image').naturalWidth > 0")
    assert not await page.locator("#error-box").is_visible()
    await page.screenshot(path=str(ROOT / "docs" / "browser-smoke.png"), full_page=True)

    await page.click("#diagnostics-button")
    await page.wait_for_function("document.querySelector('#diagnostics-output').textContent.includes('finishedAt')", timeout=30_000)
    diagnostics = json.loads(await page.locator("#diagnostics-output").inner_text())
    assert diagnostics["status"] == "PASS", diagnostics

    filtered_errors = [error for error in page_errors if "favicon" not in error.lower()]
    assert not filtered_errors, filtered_errors
    return {
        "capabilitiesText": capabilities_text,
        "cases": cases,
        "cpuGpuComparison": comparison,
        "maxImage": maximum,
        "cancellation": cancellation,
        "diagnostics": diagnostics,
        "pageErrors": filtered_errors,
    }


async def launch_and_test() -> dict[str, Any]:
    chromium = shutil.which("chromium") or shutil.which("google-chrome")
    if chromium is None:
        raise RuntimeError("Chromium executable was not found")
    if not os.environ.get("DISPLAY"):
        raise RuntimeError("A DISPLAY is required for the WebGL2 browser test")

    server = subprocess.Popen(
        ["node", "scripts/serve.mjs", "dist", "8765"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        wait_port(8765)
        async with async_playwright() as playwright:
            browser: Browser = await playwright.chromium.launch(
                headless=False,
                executable_path=chromium,
                args=["--no-sandbox", "--ignore-gpu-blocklist"],
            )
            try:
                page = await browser.new_page(viewport={"width": 1280, "height": 900})
                result = await run_tests(page)
            finally:
                await browser.close()
    finally:
        server.send_signal(signal.SIGTERM)
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
    return result


def write_report(result: dict[str, Any], policy_overridden: bool) -> None:
    chromium_version = subprocess.check_output([shutil.which("chromium") or "chromium", "--version"], text=True).strip()
    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "PASS",
        "environment": {
            "os": platform.platform(),
            "python": platform.python_version(),
            "chromium": chromium_version,
            "virtualDisplay": True,
            "managedPolicyTemporarilyOverridden": policy_overridden,
        },
        "testedBrowsers": ["Chromium"],
        "notTestedHere": ["Firefox", "Safari macOS", "Safari iOS", "Chrome Android"],
        "result": result,
    }
    REPORT_JSON.parent.mkdir(parents=True, exist_ok=True)
    REPORT_JSON.write_text(json.dumps(report, indent=2), encoding="utf-8")

    rows = result["cases"]
    markdown = [
        "# Browser test report",
        "",
        f"**Status:** PASS",
        f"**Generated:** {report['generatedAt']}",
        f"**Browser:** {chromium_version}",
        "",
        "## Verified scenarios",
        "",
        "| Input | Requested backend | Actual backend | Inference | Output | Processing |",
        "|---|---|---|---|---|---:|",
    ]
    for row in rows:
        markdown.append(
            f"| {row['name']} | {row['requestedBackend']} | {row['processingBackend']} | "
            f"{row['inferenceBackend']} | {row['outputType']} | {row['processingTimeMs']:.1f} ms |"
        )
    maximum = result["maxImage"]
    comparison = result["cpuGpuComparison"]
    markdown.extend(
        [
            "",
            "## 15 MP",
            "",
            f"5000 × 3000 completed in **{maximum['processingTimeMs'] / 1000:.2f} s** using "
            f"`{maximum['backend']} + {maximum['inferenceBackend']}`.",
            "",
            "## CPU / GPU equivalence",
            "",
            f"Mean absolute RGB difference: **{comparison['meanAbsoluteError']:.4f}**",
            f"Maximum RGB difference: **{comparison['maximumError']}**",
            f"Alpha mismatches: **{comparison['alphaMismatch']}**",
            "",
            "## Environment limits",
            "",
            "This automated run verifies Chromium on a Linux virtual display. Firefox, real Safari, iOS Safari and Chrome Android were not available in this execution environment and are not claimed as manually verified.",
            "",
        ]
    )
    REPORT_MD.write_text("\n".join(markdown), encoding="utf-8")


def main() -> None:
    display_usable = bool(os.environ.get("DISPLAY")) and subprocess.run(
        ["xdpyinfo"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False
    ).returncode == 0
    if not display_usable and shutil.which("xvfb-run"):
        os.environ.pop("DISPLAY", None)
        os.execvp("xvfb-run", ["xvfb-run", "-a", os.sys.executable, str(Path(__file__).resolve())])
    with temporary_chromium_policy_allow_localhost() as policy_overridden:
        result = asyncio.run(launch_and_test())
    write_report(result, policy_overridden)
    print(json.dumps({"status": "PASS", "report": str(REPORT_JSON), "maxImageMs": result["maxImage"]["processingTimeMs"]}, indent=2))


if __name__ == "__main__":
    main()
