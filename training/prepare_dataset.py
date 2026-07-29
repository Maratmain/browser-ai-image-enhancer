from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SUPPORTED = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def split_for_digest(digest: str) -> str:
    bucket = int(digest[:8], 16) % 100
    if bucket < 80:
        return "train"
    if bucket < 90:
        return "validation"
    return "test"


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate and deterministically split a directory of public images.")
    parser.add_argument("source", type=Path, nargs="?", default=ROOT / "training" / "data" / "public" / "coco-val2017" / "images")
    parser.add_argument("--output", type=Path, default=ROOT / "training" / "data" / "prepared")
    parser.add_argument("--minimum-side", type=int, default=64)
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    if not source.is_dir():
        raise SystemExit(f"Source directory does not exist: {source}")
    args.output.mkdir(parents=True, exist_ok=True)

    entries: list[dict[str, object]] = []
    rejected: list[dict[str, str]] = []
    seen_hashes: set[str] = set()
    for path in sorted(candidate for candidate in source.rglob("*") if candidate.suffix.lower() in SUPPORTED):
        try:
            digest = file_sha256(path)
            if digest in seen_hashes:
                rejected.append({"path": str(path), "reason": "duplicate"})
                continue
            with Image.open(path) as image:
                image.verify()
            with Image.open(path) as image:
                width, height = image.size
                if min(width, height) < args.minimum_side:
                    raise ValueError("image side below minimum")
            seen_hashes.add(digest)
            entries.append({
                "path": str(path.resolve()),
                "sha256": digest,
                "width": width,
                "height": height,
                "split": split_for_digest(digest),
            })
        except Exception as error:
            rejected.append({"path": str(path), "reason": str(error)})

    for split in ("train", "validation", "test"):
        paths = [str(entry["path"]) for entry in entries if entry["split"] == split]
        (args.output / f"{split}.txt").write_text("\n".join(paths) + ("\n" if paths else ""), encoding="utf-8")
    report = {
        "source": str(source),
        "accepted": len(entries),
        "rejected": len(rejected),
        "splits": {split: sum(1 for entry in entries if entry["split"] == split) for split in ("train", "validation", "test")},
        "entries": entries,
        "rejections": rejected,
    }
    (args.output / "index.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("source", "accepted", "rejected", "splits")}, indent=2))
    if len(entries) < 3000:
        print("Warning: fewer than 3000 unique valid source images were found.")


if __name__ == "__main__":
    main()
