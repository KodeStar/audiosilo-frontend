/**
 * Wall-clock seconds to listen to `contentSeconds` of audio at playback `rate`:
 * time on the clock shrinks with speed (60s of audio at 2x is 30s of real time).
 * The result is clamped at 0 (never negative), and a non-positive `rate` falls
 * back to 1x so the division is always safe. Callers format the number.
 *
 * The single home for the content→wall-clock conversion - the sleep timer's
 * countdowns, the chapter-end picker, and the player's "time left" all share it.
 */
export function wallClockSeconds(contentSeconds: number, rate = 1): number {
  const speed = rate > 0 ? rate : 1;
  return Math.max(0, contentSeconds) / speed;
}

/** The product's speed range: the engines support more, the product caps it at 2x. */
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

/** A speed inside the product's range (`MIN_RATE`..`MAX_RATE`): what the player plays a
 * saved or asked-for speed at, so anything that predicts that speed clamps the same way. */
export function clampRate(rate: number): number {
  return Math.max(MIN_RATE, Math.min(MAX_RATE, rate));
}
