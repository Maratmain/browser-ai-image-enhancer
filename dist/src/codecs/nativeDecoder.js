import { EnhancerError } from "../utils/errors.js";
import { decodeBmp } from "./bmpDecoder.js";
function orientedSize(width, height, orientation) {
    return orientation >= 5 && orientation <= 8 ? [height, width] : [width, height];
}
async function applyOrientation(bitmap, orientation) {
    if (orientation === 1)
        return bitmap;
    const [width, height] = orientedSize(bitmap.width, bitmap.height, orientation);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: true });
    if (context === null) {
        bitmap.close();
        throw new EnhancerError("DECODE_FAILED", "Unable to create orientation canvas", { stage: "normalizing" });
    }
    switch (orientation) {
        case 2:
            context.setTransform(-1, 0, 0, 1, bitmap.width, 0);
            break;
        case 3:
            context.setTransform(-1, 0, 0, -1, bitmap.width, bitmap.height);
            break;
        case 4:
            context.setTransform(1, 0, 0, -1, 0, bitmap.height);
            break;
        case 5:
            context.setTransform(0, 1, 1, 0, 0, 0);
            break;
        case 6:
            context.setTransform(0, 1, -1, 0, bitmap.height, 0);
            break;
        case 7:
            context.setTransform(0, -1, -1, 0, bitmap.height, bitmap.width);
            break;
        case 8:
            context.setTransform(0, -1, 1, 0, 0, bitmap.width);
            break;
        default:
            break;
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas.transferToImageBitmap();
}
async function decodeNative(blob, orientation, rawWidth, rawHeight) {
    const options = {
        imageOrientation: orientation === 1 ? "from-image" : "none",
        premultiplyAlpha: "none",
        colorSpaceConversion: "default"
    };
    const bitmap = await createImageBitmap(blob, options);
    if (orientation === 1)
        return bitmap;
    const swapsAxes = orientation >= 5 && orientation <= 8;
    const decoderAlreadyOriented = swapsAxes &&
        rawWidth !== undefined &&
        rawHeight !== undefined &&
        bitmap.width === rawHeight &&
        bitmap.height === rawWidth;
    return decoderAlreadyOriented ? bitmap : applyOrientation(bitmap, orientation);
}
async function decodeHeicWithOptionalModule(blob, moduleUrl) {
    try {
        const module = (await import(/* @vite-ignore */ moduleUrl));
        if (typeof module.heicTo === "function") {
            return await module.heicTo({ blob, type: "bitmap" });
        }
        if (typeof module.decodeHeic === "function") {
            return await module.decodeHeic(blob);
        }
        throw new Error("Decoder module exports neither heicTo nor decodeHeic");
    }
    catch (error) {
        throw new EnhancerError("HEIC_DECODER_LOAD_FAILED", "The optional HEIC software decoder could not be loaded", {
            stage: "decoding",
            recoverable: true,
            cause: error
        });
    }
}
export async function decodeImage(blob, format, probe, heicDecoderUrl) {
    if (format === "bmp") {
        const decoded = await decodeBmp(blob);
        return { ...decoded, warnings: [] };
    }
    if (format === "heic" || format === "heif") {
        try {
            const bitmap = await createImageBitmap(blob, {
                imageOrientation: "from-image",
                premultiplyAlpha: "none",
                colorSpaceConversion: "default"
            });
            return {
                bitmap,
                width: bitmap.width,
                height: bitmap.height,
                hasAlpha: false,
                warnings: []
            };
        }
        catch (nativeError) {
            if (heicDecoderUrl === undefined) {
                throw new EnhancerError("HEIC_DECODE_FAILED", "This browser cannot decode HEIC natively and no software decoder is configured", {
                    stage: "decoding",
                    recoverable: true,
                    cause: nativeError
                });
            }
            const bitmap = await decodeHeicWithOptionalModule(blob, heicDecoderUrl);
            return {
                bitmap,
                width: bitmap.width,
                height: bitmap.height,
                hasAlpha: false,
                warnings: [
                    { code: "NATIVE_DECODER_FALLBACK_USED", message: "HEIC was decoded by the configured software decoder." }
                ]
            };
        }
    }
    try {
        const bitmap = await decodeNative(blob, probe.orientation, probe.width, probe.height);
        return {
            bitmap,
            width: bitmap.width,
            height: bitmap.height,
            hasAlpha: probe.hasAlpha ?? format === "png",
            warnings: []
        };
    }
    catch (error) {
        throw new EnhancerError("DECODE_FAILED", `Unable to decode ${format.toUpperCase()} image`, {
            stage: "decoding",
            cause: error
        });
    }
}
