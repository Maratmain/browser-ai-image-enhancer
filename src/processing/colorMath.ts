import type { EnhancementParameters } from "../api/types.js";

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function srgbToLinear(value: number): number {
  const normalized = clamp01(value);
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number): number {
  const normalized = clamp01(value);
  return normalized <= 0.0031308
    ? normalized * 12.92
    : 1.055 * normalized ** (1 / 2.4) - 0.055;
}

export function correctRgb(
  red: number,
  green: number,
  blue: number,
  parameters: EnhancementParameters
): readonly [number, number, number] {
  const exposure = 2 ** parameters.exposureEV;
  let linearRed = srgbToLinear(red) * exposure;
  let linearGreen = srgbToLinear(green) * exposure;
  let linearBlue = srgbToLinear(blue) * exposure;

  linearRed = (linearRed - parameters.pivot) * parameters.contrast + parameters.pivot;
  linearGreen = (linearGreen - parameters.pivot) * parameters.contrast + parameters.pivot;
  linearBlue = (linearBlue - parameters.pivot) * parameters.contrast + parameters.pivot;

  const luminance = linearRed * 0.2126 + linearGreen * 0.7152 + linearBlue * 0.0722;
  linearRed = luminance + parameters.saturation * (linearRed - luminance);
  linearGreen = luminance + parameters.saturation * (linearGreen - luminance);
  linearBlue = luminance + parameters.saturation * (linearBlue - luminance);

  return [
    linearToSrgb(linearRed),
    linearToSrgb(linearGreen),
    linearToSrgb(linearBlue)
  ];
}
