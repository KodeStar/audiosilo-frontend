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
