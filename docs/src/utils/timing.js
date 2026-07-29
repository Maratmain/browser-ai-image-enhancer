export function now() {
    return performance.now();
}
export function roundMs(value) {
    return Math.round(value * 100) / 100;
}
