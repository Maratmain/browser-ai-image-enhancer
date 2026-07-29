from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from skimage import data
from sklearn.datasets import load_sample_images

from color import make_degraded


@dataclass(frozen=True)
class DatasetBundle:
    images: np.ndarray
    targets: np.ndarray


def _to_rgb_array(image: np.ndarray) -> np.ndarray:
    array = np.asarray(image)
    if array.ndim == 2:
        array = np.repeat(array[..., None], 3, axis=2)
    if array.shape[2] == 4:
        alpha = array[..., 3:4].astype(np.float32) / 255.0
        rgb = array[..., :3].astype(np.float32)
        array = rgb * alpha + 255.0 * (1.0 - alpha)
    array = array[..., :3]
    if array.dtype != np.uint8:
        maximum = float(np.max(array)) if array.size else 1.0
        if maximum <= 1.0:
            array = array * 255.0
        array = np.clip(array, 0, 255).astype(np.uint8)
    return array


def load_builtin_images() -> list[np.ndarray]:
    candidates: Iterable[np.ndarray] = (
        data.astronaut(),
        data.coffee(),
        data.chelsea(),
        data.rocket(),
        data.hubble_deep_field(),
        data.immunohistochemistry(),
        data.camera(),
        data.moon(),
        data.page(),
        data.grass(),
        data.gravel(),
        *load_sample_images().images,
    )
    return [_to_rgb_array(image) for image in candidates]


def _procedural_image(rng: np.random.Generator, size: int = 384) -> np.ndarray:
    image = Image.new("RGB", (size, size), tuple(int(value) for value in rng.integers(0, 220, 3)))
    draw = ImageDraw.Draw(image, "RGBA")
    for _ in range(int(rng.integers(20, 60))):
        x0, y0 = (int(value) for value in rng.integers(-size // 4, size, 2))
        x1 = x0 + int(rng.integers(size // 20, size // 2))
        y1 = y0 + int(rng.integers(size // 20, size // 2))
        color = tuple(int(value) for value in rng.integers(0, 256, 3)) + (int(rng.integers(20, 180)),)
        if rng.random() < 0.5:
            draw.ellipse((x0, y0, x1, y1), fill=color)
        else:
            draw.rectangle((x0, y0, x1, y1), fill=color)
    if rng.random() < 0.7:
        image = image.filter(ImageFilter.GaussianBlur(float(rng.uniform(0.2, 2.5))))
    array = np.asarray(image, dtype=np.float32) / 255.0
    yy, xx = np.mgrid[0:size, 0:size]
    direction = rng.uniform(0, math.tau)
    gradient = (np.cos(direction) * xx + np.sin(direction) * yy) / size
    gradient = (gradient - gradient.min()) / max(1e-6, gradient.max() - gradient.min())
    tint = rng.uniform(0.65, 1.35, size=3)
    array = np.clip(array * (0.55 + gradient[..., None] * 0.65) * tint, 0.0, 1.0)
    noise = rng.normal(0.0, rng.uniform(0.0, 0.025), size=array.shape)
    return np.clip((array + noise) * 255.0, 0, 255).astype(np.uint8)


def load_image_paths(index_file: Path | None) -> list[Path]:
    if index_file is None:
        return []
    if not index_file.exists():
        raise FileNotFoundError(f"Dataset index does not exist: {index_file}")
    paths: list[Path] = []
    for raw in index_file.read_text(encoding="utf-8").splitlines():
        value = raw.strip()
        if not value or value.startswith("#"):
            continue
        path = Path(value).expanduser().resolve()
        if path.is_file():
            paths.append(path)
    if not paths:
        raise ValueError(f"Dataset index contains no readable images: {index_file}")
    return paths


def _load_source(source: np.ndarray | Path) -> np.ndarray:
    if isinstance(source, Path):
        with Image.open(source) as opened:
            opened.load()
            return _to_rgb_array(np.asarray(opened.convert("RGB")))
    return source


def _sample_crop(image: np.ndarray, rng: np.random.Generator, output_size: int) -> np.ndarray:
    height, width = image.shape[:2]
    minimum = min(height, width)
    crop_size = int(rng.uniform(max(output_size, minimum * 0.2), minimum))
    crop_size = max(output_size, min(crop_size, minimum))
    x = int(rng.integers(0, max(1, width - crop_size + 1)))
    y = int(rng.integers(0, max(1, height - crop_size + 1)))
    crop = image[y : y + crop_size, x : x + crop_size]
    pil = Image.fromarray(crop, mode="RGB")
    if rng.random() < 0.5:
        pil = pil.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if rng.random() < 0.25:
        pil = pil.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    pil = pil.resize((output_size, output_size), Image.Resampling.LANCZOS)
    array = np.asarray(pil, dtype=np.float32) / 255.0
    if rng.random() < 0.35:
        temperature = rng.uniform(-0.08, 0.08)
        array[..., 0] += temperature
        array[..., 2] -= temperature
    return np.clip(array, 0.0, 1.0)



def teacher_parameters(image: np.ndarray) -> tuple[float, float, float, float]:
    """Robust global correction labels used to train the compact scene analyzer."""
    rgb = np.clip(image.astype(np.float32), 0.0, 1.0)
    linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    luminance = linear[..., 0] * 0.2126 + linear[..., 1] * 0.7152 + linear[..., 2] * 0.0722
    p05, p10, median, p90, p95 = np.percentile(luminance, (5, 10, 50, 90, 95))

    exposure = float(np.clip(np.log2(0.20 / max(0.015, float(median))), -1.25, 1.25))
    projected_high = float(p95 * (2.0 ** exposure))
    if projected_high > 0.96 and exposure > 0.0:
        exposure *= max(0.15, (0.96 - float(p95)) / max(1e-4, projected_high - float(p95)))

    projected_range = float((p90 - p10) * (2.0 ** exposure))
    contrast = float(np.clip(1.0 + (0.50 - projected_range) * 0.72, 0.72, 1.42))
    if p05 < 0.012 and contrast > 1.0:
        contrast = 1.0 + (contrast - 1.0) * 0.45

    maximum = rgb.max(axis=2)
    minimum = rgb.min(axis=2)
    saturation_map = (maximum - minimum) / np.maximum(maximum, 0.08)
    valid = maximum > 0.05
    mean_saturation = float(np.mean(saturation_map[valid])) if np.any(valid) else 0.0
    saturation = float(np.clip(1.0 + (0.34 - mean_saturation) * 0.75, 0.62, 1.48))
    highly_saturated = float(np.mean(saturation_map > 0.85))
    if highly_saturated > 0.12 and saturation > 1.0:
        saturation = 1.0 + (saturation - 1.0) * 0.35

    severity = max(
        abs(exposure) / 1.25,
        abs(contrast - 1.0) / 0.42,
        abs(saturation - 1.0) / 0.48,
    )
    strength = float(np.clip((severity - 0.025) / 0.25, 0.0, 1.0))
    return exposure, contrast, saturation, strength

def build_dataset(
    sample_count: int,
    seed: int,
    input_size: int = 64,
    identity_fraction: float = 0.25,
    external_paths: Sequence[Path] = (),
) -> DatasetBundle:
    rng = np.random.default_rng(seed)
    images: list[np.ndarray | Path] = list(load_builtin_images())
    images.extend(_procedural_image(rng) for _ in range(36))
    images.extend(external_paths)

    result_images = np.empty((sample_count, input_size, input_size, 3), dtype=np.uint8)
    targets = np.empty((sample_count, 4), dtype=np.float32)

    for index in range(sample_count):
        source = images[int(rng.integers(0, len(images)))]
        clean = _sample_crop(_load_source(source), rng, input_size)
        if rng.random() < identity_fraction:
            degraded = clean
        else:
            # Broad corruption distribution exposes the network to dark, flat, washed-out
            # and overprocessed scenes. Labels are then computed from the actual input.
            corruption_exposure = float(rng.triangular(-1.45, 0.0, 1.45))
            corruption_contrast = float(rng.triangular(0.55, 1.0, 1.65))
            corruption_saturation = float(rng.triangular(0.35, 1.0, 1.75))
            degraded = make_degraded(
                clean,
                -corruption_exposure,
                1.0 / corruption_contrast,
                1.0 / corruption_saturation,
            )
            if rng.random() < 0.35:
                noise = rng.normal(0.0, rng.uniform(0.0, 0.012), size=degraded.shape)
                degraded = np.clip(degraded + noise, 0.0, 1.0)

        exposure, contrast, saturation, strength = teacher_parameters(degraded)
        result_images[index] = np.clip(np.rint(degraded * 255.0), 0, 255).astype(np.uint8)
        targets[index] = (exposure, contrast, saturation, strength)

    order = rng.permutation(sample_count)
    return DatasetBundle(images=result_images[order], targets=targets[order])
