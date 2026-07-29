import type { EnhancementParameters } from "../api/types.js";
import { EnhancerError } from "../utils/errors.js";
import { correctRgb } from "./colorMath.js";
import { createTiles } from "./tiling.js";

export interface ProcessingHooks {
  readonly isCancelled: () => boolean;
  readonly onProgress: (progress: number) => void;
}

export async function processWithCpu(
  source: ImageBitmap,
  parameters: EnhancementParameters,
  tileSize: number,
  hooks: ProcessingHooks
): Promise<OffscreenCanvas> {
  const output = new OffscreenCanvas(source.width, source.height);
  const outputContext = output.getContext("2d", { alpha: true });
  if (outputContext === null) {
    throw new EnhancerError("OUT_OF_MEMORY", "Unable to allocate the output canvas", { stage: "enhancing" });
  }

  const tileCanvas = new OffscreenCanvas(1, 1);
  const tiles = createTiles(source.width, source.height, tileSize);
  for (const tile of tiles) {
    if (hooks.isCancelled()) throw new EnhancerError("TASK_CANCELLED", "Task was cancelled", { stage: "enhancing" });
    tileCanvas.width = tile.width;
    tileCanvas.height = tile.height;
    const context = tileCanvas.getContext("2d", { alpha: true, willReadFrequently: true });
    if (context === null) {
      throw new EnhancerError("OUT_OF_MEMORY", "Unable to allocate a CPU tile canvas", { stage: "enhancing" });
    }
    const tileBitmap = await createImageBitmap(source, tile.x, tile.y, tile.width, tile.height, {
      premultiplyAlpha: "none"
    });
    context.clearRect(0, 0, tile.width, tile.height);
    context.drawImage(tileBitmap, 0, 0);
    tileBitmap.close();
    const image = context.getImageData(0, 0, tile.width, tile.height);
    for (let offset = 0; offset < image.data.length; offset += 4) {
      if ((offset & 0x3ffff) === 0 && hooks.isCancelled()) {
        throw new EnhancerError("TASK_CANCELLED", "Task was cancelled", { stage: "enhancing" });
      }
      const alpha = (image.data[offset + 3] ?? 0) / 255;
      if (alpha <= 0) continue;
      const [red, green, blue] = correctRgb(
        (image.data[offset] ?? 0) / 255,
        (image.data[offset + 1] ?? 0) / 255,
        (image.data[offset + 2] ?? 0) / 255,
        parameters
      );
      image.data[offset] = Math.round(red * 255);
      image.data[offset + 1] = Math.round(green * 255);
      image.data[offset + 2] = Math.round(blue * 255);
    }
    context.putImageData(image, 0, 0);
    outputContext.drawImage(tileCanvas, tile.x, tile.y);
    hooks.onProgress(((tile.index + 1) / tile.count) * 100);
    await Promise.resolve();
  }
  return output;
}
