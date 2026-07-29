import { EnhancerError } from "../utils/errors.js";
function srgbToLinear(value) {
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function percentile(sorted, ratio) {
    if (sorted.length === 0) {
        return 0;
    }
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
    return sorted[index] ?? 0;
}
export function prepareModelInput(source, inputSize = 64) {
    const canvas = new OffscreenCanvas(inputSize, inputSize);
    const context = canvas.getContext("2d", {
        alpha: false,
        willReadFrequently: true
    });
    if (context === null) {
        throw new EnhancerError("MODEL_INFERENCE_FAILED", "Unable to create preprocessing canvas", {
            stage: "analyzing"
        });
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, inputSize, inputSize);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, inputSize, inputSize);
    const image = context.getImageData(0, 0, inputSize, inputSize);
    const pixelCount = inputSize * inputSize;
    const values = new Float32Array(pixelCount * 3);
    const luminance = new Float32Array(pixelCount);
    let dark = 0;
    let bright = 0;
    let saturationTotal = 0;
    let highlySaturated = 0;
    for (let index = 0; index < pixelCount; index += 1) {
        const offset = index * 4;
        const red = (image.data[offset] ?? 0) / 255;
        const green = (image.data[offset + 1] ?? 0) / 255;
        const blue = (image.data[offset + 2] ?? 0) / 255;
        values[index * 3] = red * 2 - 1;
        values[index * 3 + 1] = green * 2 - 1;
        values[index * 3 + 2] = blue * 2 - 1;
        const linearRed = srgbToLinear(red);
        const linearGreen = srgbToLinear(green);
        const linearBlue = srgbToLinear(blue);
        const y = linearRed * 0.2126 + linearGreen * 0.7152 + linearBlue * 0.0722;
        luminance[index] = y;
        if (y < 0.015)
            dark += 1;
        if (y > 0.94)
            bright += 1;
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        const saturation = maximum > 0.08 ? (maximum - minimum) / maximum : 0;
        saturationTotal += saturation;
        if (saturation > 0.85)
            highlySaturated += 1;
    }
    luminance.sort();
    return {
        values,
        preview: image,
        statistics: {
            medianLinearLuminance: percentile(luminance, 0.5),
            p05LinearLuminance: percentile(luminance, 0.05),
            p95LinearLuminance: percentile(luminance, 0.95),
            darkFraction: dark / pixelCount,
            brightFraction: bright / pixelCount,
            meanSaturation: saturationTotal / pixelCount,
            highlySaturatedFraction: highlySaturated / pixelCount
        }
    };
}
