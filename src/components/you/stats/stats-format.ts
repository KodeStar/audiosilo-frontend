import { formatDurationOrZero, formatShortDay, formatTimeOfDay } from '@/lib/format';

/** "Sat 3 Oct" for a server `YYYY-MM-DD` day, read as that calendar day wherever the
 * device is (noon on that date in the device's zone formats as the same date). */
export function formatServerShortDay(day: string, locale?: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return formatShortDay(new Date(y, m - 1, d, 12), locale);
}

/** An hour of the day (0-23) on the reader's clock: "22:00", "10:00 PM". */
export function formatHour(hour: number, locale?: string): string {
  return formatTimeOfDay(`${String(hour % 24).padStart(2, '0')}:00`, locale);
}

/** A duration as a stat tile sets it, the figures big and the units small:
 * `[{ n: '11', unit: 'h' }, { n: '6', unit: 'm' }]` for 11h 6m. */
export function durationParts(seconds: number): { n: string; unit: string }[] {
  return Array.from(formatDurationOrZero(seconds).matchAll(/(\d+)([a-z]+)/g), (m) => ({
    n: m[1],
    unit: m[2],
  }));
}
