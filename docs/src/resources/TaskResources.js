export class TaskResources {
    #bitmaps = new Set();
    #objectUrls = new Set();
    trackBitmap(bitmap) {
        this.#bitmaps.add(bitmap);
        return bitmap;
    }
    releaseBitmap(bitmap) {
        if (this.#bitmaps.delete(bitmap)) {
            bitmap.close();
        }
    }
    trackObjectUrl(url) {
        this.#objectUrls.add(url);
        return url;
    }
    dispose() {
        for (const bitmap of this.#bitmaps)
            bitmap.close();
        this.#bitmaps.clear();
        for (const url of this.#objectUrls)
            URL.revokeObjectURL(url);
        this.#objectUrls.clear();
    }
}
