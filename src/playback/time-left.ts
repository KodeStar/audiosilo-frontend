import type { TFunction } from 'i18next';

import { formatDuration, formatSpeed } from '@/lib/format';

import { wallClockSeconds } from './rate';

/**
 * Time left in a book, the way every screen says it (frontend#50: the speed is saved per
 * book, so the time left must use it too). One rule for the whole app:
 *
 * - The time is WALL-CLOCK time at THAT book's speed: the playing book uses the player's
 *   `rate`; any other book its saved `playback_speed`, else the default speed setting
 *   (which is what the player will start it at, see `playBook`).
 * - It says the speed: "22h 27m left at 1.25×". At 1× it says nothing about speed
 *   ("22h 27m left"): "at 1×" on every row of a library played at normal speed is noise,
 *   and a speed is only worth naming when it changes the number.
 * - The duration is `formatDuration` ("22h 27m", "45m", "30s"), the app's one compact
 *   duration, and the speed is `formatSpeed` ("1.25×"), as the speed button writes it.
 * - Unknown (a book without a timeline, `total <= 0`) or nothing left reads "" so a caller
 *   can drop the line.
 *
 * Framework-free; the React side is `src/components/player/use-time-left.ts`.
 */

export type TimeLeft = {
  /** Wall-clock seconds left at `speed`. */
  seconds: number;
  /** The speed the time was computed at (> 0). */
  speed: number;
};

/** The speed a book plays at when it is not the loaded one: its own saved speed when it
 * has one, else the listener's default speed (what `playBook` would start it at). */
export function bookSpeed(saved: number | null | undefined, defaultRate: number): number {
  if (saved && saved > 0) return saved;
  return defaultRate > 0 ? defaultRate : 1;
}

/** Time left from `position` to `total` at `speed`, or null without a timeline. */
export function timeLeft(position: number, total: number, speed: number): TimeLeft | null {
  if (!(total > 0)) return null;
  const s = speed > 0 ? speed : 1;
  return { seconds: wallClockSeconds(total - Math.max(0, position), s), speed: s };
}

/** Whether a speed reads as normal speed (no "at 1×" suffix). Two decimals, as
 * `formatSpeed` shows it, so 1.004 is 1×. */
export function isNormalSpeed(speed: number): boolean {
  return Math.round(speed * 100) === 100;
}

/** "22h 27m left at 1.25×", "45m left", or "" when unknown or nothing is left. */
export function formatTimeLeft(t: TFunction, left: TimeLeft | null): string {
  if (!left) return '';
  const time = formatDuration(left.seconds);
  if (!time) return '';
  return isNormalSpeed(left.speed)
    ? t('player.timeLeft.left', { time })
    : t('player.timeLeft.leftAt', { time, speed: formatSpeed(left.speed) });
}

/** The label under a "22h 27m" figure (the Now card's stat): "left at 1.25×", or
 * "left" at normal speed. */
export function timeLeftLabel(t: TFunction, speed: number): string {
  return isNormalSpeed(speed)
    ? t('player.timeLeft.label')
    : t('player.timeLeft.labelAt', { speed: formatSpeed(speed) });
}
