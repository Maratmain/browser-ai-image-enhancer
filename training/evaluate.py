from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader, TensorDataset

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dataset import build_dataset, load_image_paths
from model import TinyEnhancerCNN
from train import evaluate


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate the trained model on a deterministic held-out set.")
    parser.add_argument("--checkpoint", type=Path, default=ROOT / "training" / "checkpoints" / "baseline.pt")
    parser.add_argument("--test-list", type=Path)
    parser.add_argument("--samples", type=int, default=1800)
    parser.add_argument("--seed", type=int, default=20260731)
    parser.add_argument("--output", type=Path, default=ROOT / "docs" / "model-evaluation.json")
    args = parser.parse_args()

    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    model = TinyEnhancerCNN()
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()

    paths = load_image_paths(args.test_list)
    dataset = build_dataset(args.samples, args.seed, external_paths=paths)
    images = torch.from_numpy(dataset.images).permute(0, 3, 1, 2).float() / 127.5 - 1.0
    targets = torch.from_numpy(dataset.targets)
    loader = DataLoader(TensorDataset(images, targets), batch_size=128, shuffle=False)
    metrics = evaluate(model, loader, torch.device("cpu"))
    report = {
        "checkpoint": str(args.checkpoint.relative_to(ROOT)),
        "samples": args.samples,
        "seed": args.seed,
        "externalSources": len(paths),
        "metrics": metrics,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
