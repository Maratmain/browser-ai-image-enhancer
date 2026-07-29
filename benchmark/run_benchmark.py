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

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests" / "browser"))
from run_browser_tests import temporary_chromium_policy_allow_localhost, wait_port

REPORT_JSON = ROOT / "docs" / "benchmark-report.json"
REPORT_MD = ROOT / "docs" / "benchmark-report.md"


async def execute() -> dict[str, object]:
    chromium = shutil.which("chromium") or shutil.which("google-chrome")
    if chromium is None:
        raise RuntimeError("Chromium executable was not found")
    server = subprocess.Popen(
        ["node", "scripts/serve.mjs", "dist", "8766"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        wait_port(8766)
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                headless=False,
                executable_path=chromium,
                args=["--no-sandbox", "--ignore-gpu-blocklist"],
            )
            try:
                page = await browser.new_page(viewport={"width": 1280, "height": 900})
                await page.goto("http://127.0.0.1:8766/benchmark/", wait_until="networkidle")
                await page.click("#run-button")
                await page.wait_for_function("window.__imageEnhancerBenchmarkReport !== undefined", timeout=120_000)
                report = await page.evaluate("window.__imageEnhancerBenchmarkReport")
            finally:
                await browser.close()
    finally:
        server.send_signal(signal.SIGTERM)
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
    if not isinstance(report, dict):
        raise RuntimeError("Benchmark page did not produce a report")
    return report


def write_report(report: dict[str, object], policy_overridden: bool) -> None:
    summary = report.get("summary", {})
    rows = report.get("rows", [])
    result = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "PASS",
        "environment": {
            "os": platform.platform(),
            "chromium": subprocess.check_output([shutil.which("chromium") or "chromium", "--version"], text=True).strip(),
            "virtualDisplay": True,
            "managedPolicyTemporarilyOverridden": policy_overridden,
        },
        "benchmark": report,
    }
    mean = float(summary.get("mean", 0)) if isinstance(summary, dict) else 0.0
    p95 = float(summary.get("p95", 0)) if isinstance(summary, dict) else 0.0
    maximum = float(summary.get("maximum", 0)) if isinstance(summary, dict) else 0.0
    passed = mean <= 5000 and p95 <= 15000 and maximum <= 30000 and all(
        bool(row.get("success")) for row in rows if isinstance(row, dict)
    )
    result["status"] = "PASS" if passed else "FAIL"
    REPORT_JSON.write_text(json.dumps(result, indent=2), encoding="utf-8")

    markdown = [
        "# Benchmark report",
        "",
        f"**Status:** {result['status']}",
        f"**Browser:** {result['environment']['chromium']}",
        "",
        "| Case | Resolution | Backend | Inference | Decode | Enhance | Encode | Total |",
        "|---|---:|---|---|---:|---:|---:|---:|",
    ]
    for row in rows:
        if not isinstance(row, dict):
            continue
        markdown.append(
            f"| {row.get('name')} | {row.get('width')}×{row.get('height')} | {row.get('processingBackend')} | "
            f"{row.get('inferenceBackend')} | {float(row.get('decodingMs', 0)):.1f} ms | "
            f"{float(row.get('enhancementMs', 0)):.1f} ms | {float(row.get('encodingMs', 0)):.1f} ms | "
            f"{float(row.get('processingMs', 0)) / 1000:.3f} s |"
        )
    markdown.extend([
        "",
        f"- Mean: **{mean / 1000:.3f} s**",
        f"- P95: **{p95 / 1000:.3f} s**",
        f"- Maximum: **{maximum / 1000:.3f} s**",
        "",
        "The measurements include validation, decoding, preprocessing, inference, correction and encoding after model warm-up. Network loading and queue time are excluded.",
        "",
    ])
    REPORT_MD.write_text("\n".join(markdown), encoding="utf-8")
    if not passed:
        raise SystemExit("Benchmark thresholds were not met")


def main() -> None:
    subprocess.run(["node", "scripts/build.mjs"], cwd=ROOT, check=True)
    display_usable = bool(os.environ.get("DISPLAY")) and subprocess.run(
        ["xdpyinfo"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False
    ).returncode == 0
    if not display_usable and shutil.which("xvfb-run"):
        os.environ.pop("DISPLAY", None)
        os.execvp("xvfb-run", ["xvfb-run", "-a", sys.executable, str(Path(__file__).resolve())])
    with temporary_chromium_policy_allow_localhost() as policy_overridden:
        report = asyncio.run(execute())
    write_report(report, policy_overridden)
    print(json.dumps({"status": "PASS", "report": str(REPORT_JSON)}, indent=2))


if __name__ == "__main__":
    main()
