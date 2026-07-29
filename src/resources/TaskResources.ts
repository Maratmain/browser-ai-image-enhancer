export class TaskResources {
  readonly #bitmaps = new Set<ImageBitmap>();
  readonly #objectUrls = new Set<string>();

  trackBitmap<T extends ImageBitmap>(bitmap: T): T {
    this.#bitmaps.add(bitmap);
    return bitmap;
  }

  releaseBitmap(bitmap: ImageBitmap): void {
    if (this.#bitmaps.delete(bitmap)) {
      bitmap.close();
    }
  }

  trackObjectUrl(url: string): string {
    this.#objectUrls.add(url);
    return url;
  }

  dispose(): void {
    for (const bitmap of this.#bitmaps) bitmap.close();
    this.#bitmaps.clear();
    for (const url of this.#objectUrls) URL.revokeObjectURL(url);
    this.#objectUrls.clear();
  }
}
