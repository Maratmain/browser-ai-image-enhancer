from __future__ import annotations

import numpy as np


def srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    rgb = np.clip(rgb, 0.0, 1.0)
    return np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(rgb: np.ndarray) -> np.ndarray:
    rgb = np.clip(rgb, 0.0, 1.0)
    return np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1.0 / 2.4) - 0.055)


def apply_correction(
    image: np.ndarray,
    exposure_ev: float,
    contrast: float,
    saturation: float,
    pivot: float = 0.18,
) -> np.ndarray:
    linear = srgb_to_linear(image.astype(np.float32))
    linear = linear * (2.0 ** exposure_ev)
    linear = (linear - pivot) * contrast + pivot
    luminance = (
        linear[..., 0] * 0.2126
        + linear[..., 1] * 0.7152
        + linear[..., 2] * 0.0722
    )[..., None]
    linear = luminance + saturation * (linear - luminance)
    return linear_to_srgb(np.clip(linear, 0.0, 1.0)).astype(np.float32)


def make_degraded(
    clean: np.ndarray,
    target_exposure_ev: float,
    target_contrast: float,
    target_saturation: float,
    pivot: float = 0.18,
) -> np.ndarray:
    """Apply the inverse operations in reverse order so the targets restore the image."""
    linear = srgb_to_linear(clean.astype(np.float32))

    
    luminance = (
        linear[..., 0] * 0.2126
        + linear[..., 1] * 0.7152
        + linear[..., 2] * 0.0722
    )[..., None]
    linear = luminance + (1.0 / target_saturation) * (linear - luminance)

    
    linear = (linear - pivot) / target_contrast + pivot

    
    linear = linear * (2.0 ** (-target_exposure_ev))
    return linear_to_srgb(np.clip(linear, 0.0, 1.0)).astype(np.float32)
