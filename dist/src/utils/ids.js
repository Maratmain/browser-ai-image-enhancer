export function createTaskId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    random[6] = ((random[6] ?? 0) & 0x0f) | 0x40;
    random[8] = ((random[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(random, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
