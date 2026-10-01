/** Internal helpers shared by adapters; not part of the package API. */

/** A finite positive value, otherwise zero. */
export function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
