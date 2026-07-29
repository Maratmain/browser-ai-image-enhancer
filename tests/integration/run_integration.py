from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    subprocess.run(["node", "scripts/build.mjs"], cwd=ROOT, check=True)
    manifest = json.loads((ROOT / "dist" / "asset-manifest.json").read_text(encoding="utf-8"))
    required = [
        "index.html",
        "src/index.js",
        "src/worker/image.worker.js",
        "assets/model.wasm",
        "assets/model.json",
        "benchmark/index.html",
        "assets/remote-assets.json",
        "THIRD_PARTY_LICENSES.md",
        "licenses/heic-to-LGPL-3.0.txt",
    ]
    missing = [path for path in required if path not in manifest]
    if missing:
        raise SystemExit(f"Missing production files: {missing}")
    if manifest["assets/model.wasm"]["bytes"] <= 0:
        raise SystemExit("WASM model is empty")
    print(json.dumps({"status": "PASS", "checkedFiles": required}, indent=2))


if __name__ == "__main__":
    main()
