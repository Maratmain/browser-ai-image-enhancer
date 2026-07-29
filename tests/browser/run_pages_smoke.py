from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests" / "browser"))
from run_browser_tests import temporary_chromium_policy_allow_localhost, wait_port


async def execute() -> dict[str, object]:
    chromium = shutil.which("chromium") or shutil.which("google-chrome")
    if chromium is None:
        raise RuntimeError("Chromium executable was not found")
    server = subprocess.Popen(
        ["node", "scripts/serve.mjs", "docs", "8768"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    errors: list[str] = []
    try:
        wait_port(8768)
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                headless=False,
                executable_path=chromium,
                args=["--no-sandbox", "--ignore-gpu-blocklist"],
            )
            try:
                page = await browser.new_page(viewport={"width": 1200, "height": 850})
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
                await page.goto("http://127.0.0.1:8768/", wait_until="networkidle")
                await page.wait_for_function("!document.querySelector('#capabilities-grid .skeleton')", timeout=20_000)
                await page.set_input_files("#file-input", str(ROOT / "tests" / "fixtures" / "sample.jpg"))
                await page.click("#enhance-button")
                await page.wait_for_selector("#result-section:not(.hidden)", timeout=30_000)
                status = await page.locator("#status-label").inner_text()
                backend = await page.locator("#metric-backend").inner_text()
            finally:
                await browser.close()
    finally:
        server.send_signal(signal.SIGTERM)
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
    filtered = [error for error in errors if "favicon" not in error.lower()]
    if filtered:
        raise RuntimeError(f"Pages smoke test errors: {filtered}")
    return {"status": status, "backend": backend, "errors": filtered}


def main() -> None:
    subprocess.run(["npm", "run", "pages"], cwd=ROOT, check=True)
    display_usable = bool(os.environ.get("DISPLAY")) and subprocess.run(
        ["xdpyinfo"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False
    ).returncode == 0
    if not display_usable and shutil.which("xvfb-run"):
        os.environ.pop("DISPLAY", None)
        os.execvp("xvfb-run", ["xvfb-run", "-a", sys.executable, str(Path(__file__).resolve())])
    with temporary_chromium_policy_allow_localhost():
        result = asyncio.run(execute())
    print(json.dumps({"result": "PASS", **result}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
