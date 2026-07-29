from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = ROOT / "training" / "data" / "public"

DATASETS = {
    "coco-val2017": {
        "url": "https://images.cocodataset.org/zips/val2017.zip",
        "archive": "val2017.zip",
        "expected_images": 5000,
        "terms": "https://cocodataset.org/#termsofuse",
        "notice": (
            "COCO does not own the copyright of the images. Each image remains governed by "
            "its Flickr terms. The downloaded images are training inputs only and must not be "
            "committed or redistributed with this project."
        ),
    }
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as output:
        total = int(response.headers.get("Content-Length", "0"))
        received = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
            received += len(chunk)
            if total:
                print(f"downloaded {received / 1024 / 1024:.1f} / {total / 1024 / 1024:.1f} MiB", end="\r")
    partial.replace(destination)
    print()


def main() -> None:
    parser = argparse.ArgumentParser(description="Download an optional public image dataset for full training.")
    parser.add_argument("--dataset", choices=sorted(DATASETS), default="coco-val2017")
    parser.add_argument("--accept-image-terms", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    definition = DATASETS[args.dataset]
    if not args.accept_image_terms:
        print(definition["notice"], file=sys.stderr)
        print(f"Review: {definition['terms']}", file=sys.stderr)
        print("Re-run with --accept-image-terms after accepting the terms.", file=sys.stderr)
        raise SystemExit(2)

    destination = DATA_ROOT / args.dataset
    archive = destination / str(definition["archive"])
    extracted = destination / "images"
    if extracted.exists() and not args.force:
        print(f"Already prepared: {extracted}")
        return
    if args.force and destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True, exist_ok=True)

    download(str(definition["url"]), archive)
    archive_sha256 = sha256_file(archive)
    with zipfile.ZipFile(archive) as bundle:
        names = [name for name in bundle.namelist() if not name.endswith("/")]
        bundle.extractall(destination)
    source = destination / "val2017"
    if not source.is_dir():
        raise RuntimeError("The COCO archive did not contain val2017/")
    source.replace(extracted)
    archive.unlink(missing_ok=True)

    image_count = sum(1 for path in extracted.rglob("*") if path.suffix.lower() in {".jpg", ".jpeg", ".png"})
    if image_count < int(definition["expected_images"]):
        raise RuntimeError(f"Expected at least {definition['expected_images']} images, found {image_count}")
    metadata = {
        "dataset": args.dataset,
        "sourceUrl": definition["url"],
        "termsUrl": definition["terms"],
        "notice": definition["notice"],
        "archiveSha256": archive_sha256,
        "imageCount": image_count,
    }
    (destination / "dataset.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
