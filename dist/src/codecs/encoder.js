import { EnhancerError } from "../utils/errors.js";
function resolveOutputType(requested, inputFormat, hasAlpha) {
    if (requested !== "auto")
        return requested;
    if (hasAlpha || inputFormat === "png" || inputFormat === "bmp")
        return "image/png";
    return "image/jpeg";
}
function parseColor(color) {
    const value = color.trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff";
}
export async function encodeCanvas(canvas, inputFormat, hasAlpha, options) {
    const requestedType = resolveOutputType(options.outputType, inputFormat, hasAlpha);
    let source = canvas;
    const warnings = [];
    if (requestedType === "image/jpeg" && hasAlpha) {
        const composite = new OffscreenCanvas(canvas.width, canvas.height);
        const context = composite.getContext("2d", { alpha: false });
        if (context === null) {
            throw new EnhancerError("ENCODE_FAILED", "Unable to create JPEG compositing canvas", { stage: "encoding" });
        }
        context.fillStyle = parseColor(options.backgroundColor);
        context.fillRect(0, 0, composite.width, composite.height);
        context.drawImage(canvas, 0, 0);
        source = composite;
        warnings.push({
            code: "JPEG_ALPHA_COMPOSITED",
            message: "Прозрачные пиксели совмещены с фоном для вывода JPEG."
        });
    }
    let blob;
    try {
        blob = await source.convertToBlob({
            type: requestedType,
            ...(requestedType === "image/jpeg" ? { quality: options.jpegQuality } : {})
        });
    }
    catch (error) {
        throw new EnhancerError("ENCODE_FAILED", "The browser failed to encode the enhanced image", {
            stage: "encoding",
            cause: error
        });
    }
    if (blob.size === 0) {
        throw new EnhancerError("ENCODE_FAILED", "The browser returned an empty encoded image", { stage: "encoding" });
    }
    const actualType = blob.type === "image/jpeg" ? "image/jpeg" : "image/png";
    if (actualType !== requestedType) {
        warnings.push({
            code: "OUTPUT_MIME_CHANGED",
            message: `Браузер создал ${actualType} вместо ${requestedType}.`
        });
    }
    return { blob, mimeType: actualType, warnings };
}
