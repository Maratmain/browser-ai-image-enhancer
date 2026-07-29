function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}
function mix(neutral, predicted, strength) {
    return neutral + (predicted - neutral) * strength;
}
function estimateClipping(statistics, exposureEV, contrast, pivot) {
    const multiplier = 2 ** exposureEV;
    const low = (statistics.p05LinearLuminance * multiplier - pivot) * contrast + pivot;
    const high = (statistics.p95LinearLuminance * multiplier - pivot) * contrast + pivot;
    return {
        shadows: low < 0 ? Math.min(1, statistics.darkFraction + Math.abs(low) * 2) : statistics.darkFraction * 0.25,
        highlights: high > 1 ? Math.min(1, statistics.brightFraction + (high - 1) * 2) : statistics.brightFraction * 0.25
    };
}
export function applySafetyGuard(predicted, statistics) {
    const pivot = clamp(statistics.medianLinearLuminance, 0.1, 0.5);
    const severity = Math.max(Math.abs(predicted.exposureEV) / 1.25, Math.abs(predicted.contrast - 1) / 0.45, Math.abs(predicted.saturation - 1) / 0.5);
    let strength = clamp(predicted.correctionStrength, 0, 1) * clamp(severity / 0.08, 0, 1);
    if (statistics.highlySaturatedFraction > 0.12 && predicted.saturation > 1) {
        strength *= 0.72;
    }
    for (let iteration = 0; iteration < 7; iteration += 1) {
        const exposure = mix(0, predicted.exposureEV, strength);
        const contrast = mix(1, predicted.contrast, strength);
        const clipping = estimateClipping(statistics, exposure, contrast, pivot);
        if (clipping.highlights <= 0.08 && clipping.shadows <= 0.10) {
            break;
        }
        strength *= 0.82;
    }
    return {
        exposureEV: clamp(mix(0, predicted.exposureEV, strength), -1.25, 1.25),
        contrast: clamp(mix(1, predicted.contrast, strength), 0.7, 1.45),
        saturation: clamp(mix(1, predicted.saturation, strength), 0.6, 1.5),
        correctionStrength: clamp(strength, 0, 1),
        pivot
    };
}
