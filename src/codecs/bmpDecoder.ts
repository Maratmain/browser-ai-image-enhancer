import { EnhancerError } from "../utils/errors.js";

export interface BmpDecodeResult {
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
}

export async function decodeBmp(blob: Blob): Promise<BmpDecodeResult> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new EnhancerError("INVALID_IMAGE", "Invalid BMP header", { stage: "decoding" });
  }
  const pixelOffset = view.getUint32(10, true);
  const dibSize = view.getUint32(14, true);
  if (dibSize < 40) {
    throw new EnhancerError("UNSUPPORTED_BMP_VARIANT", "Only BITMAPINFOHEADER BMP files are supported", {
      stage: "decoding"
    });
  }
  const signedWidth = view.getInt32(18, true);
  const signedHeight = view.getInt32(22, true);
  const width = Math.abs(signedWidth);
  const height = Math.abs(signedHeight);
  const planes = view.getUint16(26, true);
  const bitsPerPixel = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  if (width < 1 || height < 1 || planes !== 1 || compression !== 0 || (bitsPerPixel !== 24 && bitsPerPixel !== 32)) {
    throw new EnhancerError("UNSUPPORTED_BMP_VARIANT", "BMP must be uncompressed 24-bit BGR or 32-bit BGRA", {
      stage: "decoding",
      details: { width, height, planes, bitsPerPixel, compression }
    });
  }

  const bytesPerPixel = bitsPerPixel / 8;
  const rowStride = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  const required = pixelOffset + rowStride * height;
  if (required > bytes.length) {
    throw new EnhancerError("INVALID_IMAGE", "BMP pixel data is truncated", { stage: "decoding" });
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const topDown = signedHeight < 0;
  let sawNonZeroAlpha = false;
  for (let y = 0; y < height; y += 1) {
    const sourceY = topDown ? y : height - 1 - y;
    const row = pixelOffset + sourceY * rowStride;
    for (let x = 0; x < width; x += 1) {
      const source = row + x * bytesPerPixel;
      const target = (y * width + x) * 4;
      rgba[target] = bytes[source + 2] ?? 0;
      rgba[target + 1] = bytes[source + 1] ?? 0;
      rgba[target + 2] = bytes[source] ?? 0;
      const alpha = bitsPerPixel === 32 ? bytes[source + 3] ?? 0 : 255;
      rgba[target + 3] = alpha;
      if (alpha !== 0 && alpha !== 255) sawNonZeroAlpha = true;
      if (bitsPerPixel === 32 && alpha === 255) sawNonZeroAlpha = true;
    }
  }

  if (bitsPerPixel === 32 && !sawNonZeroAlpha) {
    for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255;
  }
  const imageData = new ImageData(rgba, width, height);
  const bitmap = await createImageBitmap(imageData, { premultiplyAlpha: "none" });
  return { bitmap, width, height, hasAlpha: bitsPerPixel === 32 && sawNonZeroAlpha };
}
