import { EnhancerError } from "../utils/errors.js";
import { parseExifOrientation } from "./exifOrientation.js";
function probePng(bytes) {
    if (bytes.length < 29)
        throw new EnhancerError("INVALID_IMAGE", "PNG header is truncated", { stage: "validating" });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    const colorType = bytes[25] ?? 0;
    let hasAlpha = colorType === 4 || colorType === 6;
    if (!hasAlpha) {
        const text = new TextDecoder("latin1").decode(bytes);
        hasAlpha = text.includes("tRNS");
    }
    return { width, height, hasAlpha, orientation: 1 };
}
function probeBmp(bytes) {
    if (bytes.length < 30)
        throw new EnhancerError("INVALID_IMAGE", "BMP header is truncated", { stage: "validating" });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dibSize = view.getUint32(14, true);
    if (dibSize < 40 || bytes.length < 54) {
        throw new EnhancerError("UNSUPPORTED_BMP_VARIANT", "Only BITMAPINFOHEADER BMP files are supported", {
            stage: "validating"
        });
    }
    const width = Math.abs(view.getInt32(18, true));
    const height = Math.abs(view.getInt32(22, true));
    const bits = view.getUint16(28, true);
    return { width, height, hasAlpha: bits === 32, orientation: 1 };
}
function probeJpeg(bytes) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) {
            offset += 1;
            continue;
        }
        let markerOffset = offset + 1;
        while (markerOffset < bytes.length && bytes[markerOffset] === 0xff)
            markerOffset += 1;
        const marker = bytes[markerOffset] ?? 0;
        offset = markerOffset + 1;
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7))
            continue;
        if (marker === 0xd9 || marker === 0xda)
            break;
        if (offset + 2 > bytes.length)
            break;
        const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
        if (length < 2 || offset + length > bytes.length)
            break;
        const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf);
        if (isStartOfFrame && length >= 7) {
            const height = ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0);
            const width = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
            const orientation = parseExifOrientation(bytes);
            return { width, height, hasAlpha: false, orientation };
        }
        offset += length;
    }
    throw new EnhancerError("INVALID_IMAGE", "JPEG dimensions could not be read", { stage: "validating" });
}
export async function probeImage(blob, format) {
    if (format === "heic" || format === "heif") {
        return { orientation: 1 };
    }
    const maximumHeader = format === "jpeg" ? 1024 * 1024 : 64 * 1024;
    const bytes = new Uint8Array(await blob.slice(0, maximumHeader).arrayBuffer());
    if (format === "jpeg")
        return probeJpeg(bytes);
    if (format === "png")
        return probePng(bytes);
    return probeBmp(bytes);
}
