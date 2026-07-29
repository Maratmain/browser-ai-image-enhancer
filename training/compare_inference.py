from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare checkpoint vectors with JavaScript and WebAssembly runtimes.")
    parser.add_argument("--test-file", default="tests/node/core.test.mjs")
    args = parser.parse_args()
    subprocess.run(["node", "scripts/build.mjs"], cwd=ROOT, check=True)
    completed = subprocess.run(["node", "--test", args.test_file], cwd=ROOT, check=False)
    report = {"status": "PASS" if completed.returncode == 0 else "FAIL", "returnCode": completed.returncode}
    print(json.dumps(report, indent=2))
    raise SystemExit(completed.returncode)


if __name__ == "__main__":
    main()
