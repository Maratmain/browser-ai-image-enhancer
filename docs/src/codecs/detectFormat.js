import { EnhancerError } from "../utils/errors.js";
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);
function ascii(bytes, offset, length) {
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
export async function detectFormat(blob) {
    const bytes = new Uint8Array(await blob.slice(0, 128).arrayBuffer());
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "jpeg";
    }
    if (bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a) {
        return "png";
    }
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
        return "bmp";
    }
    if (bytes.length >= 16) {
        let offset = 0;
        while (offset + 12 <= bytes.length) {
            const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
            let size = view.getUint32(0, false);
            const type = ascii(bytes, offset + 4, 4);
            let headerSize = 8;
            if (size === 1 && offset + 16 <= bytes.length) {
                const high = view.getUint32(8, false);
                const low = view.getUint32(12, false);
                if (high !== 0)
                    break;
                size = low;
                headerSize = 16;
            }
            if (type === "ftyp" && offset + headerSize + 4 <= bytes.length) {
                const end = Math.min(bytes.length, size > 0 ? offset + size : bytes.length);
                for (let brandOffset = offset + headerSize; brandOffset + 4 <= end; brandOffset += 4) {
                    const brand = ascii(bytes, brandOffset, 4);
                    if (HEIC_BRANDS.has(brand))
                        return "heic";
                    if (HEIF_BRANDS.has(brand))
                        return "heif";
                }
            }
            if (size < 8)
                break;
            offset += size;
        }
    }
    throw new EnhancerError("UNSUPPORTED_FORMAT", "The file signature is not a supported image format", {
        recoverable: true,
        stage: "validating"
    });
}
