/** The speed sheet's range and step (STYLEGUIDE section 8, "Sheets"). The store clamps
 * to the same range; this module also snaps, which the store does not. */
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;
export const SPEED_STEP = 0.05;

/** The preset grid, in order. */
export const SPEED_PRESETS: readonly number[] = [0.8, 1, 1.1, 1.2, 1.25, 1.3, 1.5, 2];

/** A speed on the 0.05 grid, inside the range, without float dust (1.1500000000000001). */
export function snapSpeed(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, rate));
  return Number((Math.round(clamped / SPEED_STEP) * SPEED_STEP).toFixed(2));
}

/** Is `rate` this preset? (Speeds are snapped, but a stored one may not be.) */
export function isSpeed(rate: number, preset: number): boolean {
  return Math.abs(rate - preset) < 0.001;
}

/** The speed one step slower (-1) or faster (+1) than `rate`, on the grid (the `[` / `]`
 * shortcuts). */
export function steppedRate(rate: number, direction: 1 | -1): number {
  return snapSpeed(rate + direction * SPEED_STEP);
}
