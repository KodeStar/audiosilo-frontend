/**
 * Wall-clock "HH:MM" values: parsing, formatting, and the window test the auto sleep
 * timer arms inside.
 *
 * They live in `lib` rather than in the settings store that persists the values,
 * because they are pure string/date arithmetic with no state of their own and their
 * consumers run in both directions: `@/lib/format` renders a bound in the reader's
 * clock convention, `@/components/ui/time-stepper` steps one, and
 * `@/playback/auto-sleep` tests the clock against the pair. Keeping them in the store
 * meant `@/lib/format` - imported by some twenty modules - dragged zustand, the
 * persisted settings and the playback queue into every one of their graphs.
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since local midnight for a canonical "HH:MM" (24h) value, or `null`
 * when it is malformed. */
export function parseHhMm(value: string): number | null {
  const m = HHMM.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Canonical "HH:MM" (24h) for a minutes-since-midnight value, wrapping into a
 * single day so stepping past 23:59 or below 00:00 rolls around. */
export function formatHhMm(minutes: number): string {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  return `${String(h).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Whether `date`'s local wall-clock time falls inside the [from, until) window,
 * handling windows that wrap past midnight (22:00 -> 06:00).
 *
 * `from === until` is a zero-length window and reads as **never** (not "always"):
 * the UI only ever produces it by stepping one bound onto the other, where the
 * user's intent is plainly not "every hour of the day". A malformed bound is also
 * `false`, so a corrupt persisted value can never arm a timer unexpectedly.
 */
export function withinAutoSleepWindow(from: string, until: string, date: Date): boolean {
  const start = parseHhMm(from);
  const end = parseHhMm(until);
  if (start === null || end === null || start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}
