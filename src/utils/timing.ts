export function now(): number {
  return performance.now();
}

export function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}
