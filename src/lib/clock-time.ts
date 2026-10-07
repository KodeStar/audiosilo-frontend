import { formatTimeOfDay } from './format';

/**
 * The local wall-clock time of an instant, in the reader's clock convention ("22:49",
 * or "10:49 PM" in en-US): "ends 22:49", "You drifted off around 23:41".
 *
 * Goes through `formatTimeOfDay`, which owns the locale formatter, its cache and the
 * Hermes fallback; this only turns the instant into the "HH:MM" that takes.
 */
export function formatClockTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return formatTimeOfDay(`${hh}:${mm}`);
}
