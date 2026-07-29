from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dataset import build_dataset, load_image_paths
from model import TinyEnhancerCNN, transform_outputs


def weighted_parameter_loss(predicted: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    huber = nn.functional.smooth_l1_loss
    exposure = huber(predicted[:, 0], target[:, 0], beta=0.08)
    contrast = huber(predicted[:, 1], target[:, 1], beta=0.04)
    saturation = huber(predicted[:, 2], target[:, 2], beta=0.05)
    strength = nn.functional.binary_cross_entropy(predicted[:, 3], target[:, 3])
    identity_mask = target[:, 3] < 0.5
    identity_penalty = torch.tensor(0.0, device=predicted.device)
    if torch.any(identity_mask):
        neutral = torch.stack(
            (
                predicted[identity_mask, 0],
                predicted[identity_mask, 1] - 1.0,
                predicted[identity_mask, 2] - 1.0,
            ),
            dim=1,
        )
        identity_penalty = torch.mean(torch.abs(neutral))
    return exposure + 2.0 * contrast + 1.5 * saturation + 0.35 * strength + 0.8 * identity_penalty


def evaluate(model: nn.Module, loader: DataLoader, device: torch.device) -> dict[str, float]:
    model.eval()
    losses: list[float] = []
    absolute: list[np.ndarray] = []
    strength_correct = 0
    strength_total = 0
    with torch.no_grad():
        for images, targets in loader:
            images = images.to(device)
            targets = targets.to(device)
            predicted = transform_outputs(model(images))
            losses.append(float(weighted_parameter_loss(predicted, targets).item()))
            absolute.append(torch.abs(predicted[:, :3] - targets[:, :3]).cpu().numpy())
            strength_correct += int(((predicted[:, 3] >= 0.5) == (targets[:, 3] >= 0.5)).sum().item())
            strength_total += targets.shape[0]
    errors = np.concatenate(absolute, axis=0)
    return {
        "loss": float(np.mean(losses)),
        "exposure_mae": float(errors[:, 0].mean()),
        "contrast_mae": float(errors[:, 1].mean()),
        "saturation_mae": float(errors[:, 2].mean()),
        "strength_accuracy": float(strength_correct / max(1, strength_total)),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train-samples", type=int, default=7000)
    parser.add_argument("--validation-samples", type=int, default=1400)
    parser.add_argument("--epochs", type=int, default=18)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--seed", type=int, default=20260729)
    parser.add_argument("--output", type=Path, default=ROOT / "training" / "checkpoints" / "baseline.pt")
    parser.add_argument("--train-list", type=Path)
    parser.add_argument("--validation-list", type=Path)
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(min(8, max(1, torch.get_num_threads())))

    train_paths = load_image_paths(args.train_list)
    validation_paths = load_image_paths(args.validation_list)
    train = build_dataset(args.train_samples, args.seed, external_paths=train_paths)
    validation = build_dataset(args.validation_samples, args.seed + 1, external_paths=validation_paths)

    train_images = torch.from_numpy(train.images).permute(0, 3, 1, 2).float() / 127.5 - 1.0
    validation_images = torch.from_numpy(validation.images).permute(0, 3, 1, 2).float() / 127.5 - 1.0
    train_targets = torch.from_numpy(train.targets)
    validation_targets = torch.from_numpy(validation.targets)

    train_loader = DataLoader(
        TensorDataset(train_images, train_targets),
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=0,
    )
    validation_loader = DataLoader(
        TensorDataset(validation_images, validation_targets),
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=0,
    )

    device = torch.device("cpu")
    model = TinyEnhancerCNN().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2.0e-3, weight_decay=1.0e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)

    best_loss = float("inf")
    best_epoch = 0
    args.output.parent.mkdir(parents=True, exist_ok=True)
    history: list[dict[str, float | int]] = []

    for epoch in range(1, args.epochs + 1):
        model.train()
        epoch_losses: list[float] = []
        for images, targets in train_loader:
            images = images.to(device)
            targets = targets.to(device)
            optimizer.zero_grad(set_to_none=True)
            predicted = transform_outputs(model(images))
            loss = weighted_parameter_loss(predicted, targets)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
            optimizer.step()
            epoch_losses.append(float(loss.item()))
        scheduler.step()

        metrics = evaluate(model, validation_loader, device)
        row: dict[str, float | int] = {
            "epoch": epoch,
            "train_loss": float(np.mean(epoch_losses)),
            **metrics,
        }
        history.append(row)
        print(json.dumps(row, ensure_ascii=False))

        if metrics["loss"] < best_loss:
            best_loss = metrics["loss"]
            best_epoch = epoch
            torch.save(
                {
                    "state_dict": model.state_dict(),
                    "seed": args.seed,
                    "epoch": epoch,
                    "metrics": metrics,
                    "architecture": "tiny-cnn-v1",
                    "input_size": 64,
                },
                args.output,
            )

    history_path = args.output.with_suffix(".history.json")
    history_path.write_text(
        json.dumps({"best_epoch": best_epoch, "best_loss": best_loss, "history": history}, indent=2),
        encoding="utf-8",
    )
    print(f"saved={args.output} best_epoch={best_epoch} best_loss={best_loss:.6f}")


if __name__ == "__main__":
    main()
