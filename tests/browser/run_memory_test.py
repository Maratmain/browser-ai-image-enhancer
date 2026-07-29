from __future__ import annotations

import asyncio
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests" / "browser"))
from run_browser_tests import temporary_chromium_policy_allow_localhost, wait_port

REPORT_JSON = ROOT / "docs" / "memory-report.json"
REPORT_MD = ROOT / "docs" / "memory-report.md"

SEQUENCE_SCRIPT = """
async ({ count }) => {
  const { ImageEnhancer } = await import('/src/index.js');
  const enhancer = new ImageEnhancer({ resultRetentionMs: 60000 });
  await enhancer.ready();
  const times = [];
  for (let index = 0; index < count; index += 1) {
    const canvas = new OffscreenCanvas(1920, 1080);
    const context = canvas.getContext('2d', { alpha: false });
    const gradient = context.createLinearGradient(0, 0, 1920, 1080);
    gradient.addColorStop(0, `hsl(${index * 29} 70% 18%)`);
    gradient.addColorStop(1, `hsl(${index * 47 + 120} 75% 78%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1920, 1080);
    const input = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const taskId = enhancer.createTask(input, { outputType: 'image/jpeg', processingBackend: 'auto' });
    const output = await enhancer.getResult(taskId);
    const info = enhancer.getStatus(taskId);
    times.push({ processingMs: info.processingTimeMs, outputBytes: output.size, backend: info.processingBackend });
    await enhancer.disposeTask(taskId);
  }
  await enhancer.dispose();
  return times;
}
"""


async def heap_metrics(session) -> dict[str, float]:
    await session.send("HeapProfiler.collectGarbage")
    metrics = await session.send("Performance.getMetrics")
    return {entry["name"]: float(entry["value"]) for entry in metrics["metrics"]}


async def execute() -> dict[str, object]:
    chromium = shutil.which("chromium") or shutil.which("google-chrome")
    if chromium is None:
        raise RuntimeError("Chromium executable was not found")
    server = subprocess.Popen(
        ["node", "scripts/serve.mjs", "dist", "8767"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        wait_port(8767)
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                headless=False,
                executable_path=chromium,
                args=["--no-sandbox", "--ignore-gpu-blocklist", "--enable-precise-memory-info"],
            )
            try:
                page = await browser.new_page()
                await page.goto("http://127.0.0.1:8767/", wait_until="networkidle")
                session = await page.context.new_cdp_session(page)
                await session.send("Performance.enable")
                before = await heap_metrics(session)
                runs = await page.evaluate(SEQUENCE_SCRIPT, {"count": 10})
                after = await heap_metrics(session)
            finally:
                await browser.close()
    finally:
        server.send_signal(signal.SIGTERM)
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
    before_heap = before.get("JSHeapUsedSize", 0.0)
    after_heap = after.get("JSHeapUsedSize", 0.0)
    growth = after_heap - before_heap
    return {
        "runs": runs,
        "beforeJsHeapBytes": before_heap,
        "afterJsHeapBytes": after_heap,
        "retainedGrowthBytes": growth,
        "passed": growth <= 32 * 1024 * 1024 and len(runs) == 10,
    }


def write_report(result: dict[str, object], policy_overridden: bool) -> None:
    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "PASS" if result["passed"] else "FAIL",
        "environment": {
            "os": platform.platform(),
            "chromium": subprocess.check_output([shutil.which("chromium") or "chromium", "--version"], text=True).strip(),
            "virtualDisplay": True,
            "managedPolicyTemporarilyOverridden": policy_overridden,
        },
        "scope": "Chromium renderer JavaScript heap after explicit garbage collection; GPU and browser decoder memory are not included.",
        "result": result,
    }
    REPORT_JSON.write_text(json.dumps(report, indent=2), encoding="utf-8")
    growth_mib = float(result["retainedGrowthBytes"]) / 1024 / 1024
    markdown = [
        "# Memory report",
        "",
        f"**Status:** {report['status']}",
        "",
        "Ten sequential 1920×1080 tasks were completed and disposed. Chromium garbage collection was requested before and after the sequence.",
        "",
        f"- JavaScript heap before: **{float(result['beforeJsHeapBytes']) / 1024 / 1024:.2f} MiB**",
        f"- JavaScript heap after: **{float(result['afterJsHeapBytes']) / 1024 / 1024:.2f} MiB**",
        f"- Retained difference: **{growth_mib:.2f} MiB**",
        "",
        "This is a retained JavaScript-heap test, not a complete process-memory measurement. GPU textures, image decoder allocations and browser-managed Blob storage are outside the exposed metric.",
        "",
    ]
    REPORT_MD.write_text("\n".join(markdown), encoding="utf-8")
    if not result["passed"]:
        raise SystemExit("Memory retention threshold was exceeded")


def main() -> None:
    subprocess.run(["node", "scripts/build.mjs"], cwd=ROOT, check=True)
    display_usable = bool(os.environ.get("DISPLAY")) and subprocess.run(
        ["xdpyinfo"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False
    ).returncode == 0
    if not display_usable and shutil.which("xvfb-run"):
        os.environ.pop("DISPLAY", None)
        os.execvp("xvfb-run", ["xvfb-run", "-a", sys.executable, str(Path(__file__).resolve())])
    with temporary_chromium_policy_allow_localhost() as policy_overridden:
        result = asyncio.run(execute())
    write_report(result, policy_overridden)
    print(json.dumps({"status": "PASS", "report": str(REPORT_JSON)}, indent=2))


if __name__ == "__main__":
    main()
