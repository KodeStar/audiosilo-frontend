import { getLocale } from '@/i18n/locale';

/**
 * The Journal's dates in the reader's locale: "Saturday" and "3 October". Each falls
 * back to a plain form where the runtime has no usable `Intl.DateTimeFormat` (Hermes
 * ships a reduced Intl), like `src/lib/format.ts`.
 */

const cache = new Map<string, Intl.DateTimeFormat>();

function format(date: Date, use: string, opts: Intl.DateTimeFormatOptions, locale: string) {
  const id = `${locale}|${use}`;
  try {
    let fmt = cache.get(id);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat(locale, opts);
      cache.set(id, fmt);
    }
    return fmt.format(date);
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The local date as "2026-10-03" (the fallback: an ISO string would be the UTC day). */
const localIsoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "Saturday". */
export function formatWeekday(date: Date, locale: string = getLocale()): string {
  return format(date, 'weekday', { weekday: 'long' }, locale) ?? formatDayDate(date, locale);
}

/** "3 October" ("October 3" in en-US), with the year when it isn't this one. */
export function formatDayDate(date: Date, locale: string = getLocale(), now = new Date()): string {
  const sameYear = date.getFullYear() === now.getFullYear();
  return (
    format(
      date,
      sameYear ? 'dayMonth' : 'dayMonthYear',
      sameYear
        ? { day: 'numeric', month: 'long' }
        : { day: 'numeric', month: 'long', year: 'numeric' },
      locale,
    ) ?? localIsoDay(date)
  );
}

/** "Sun 3 Oct": a short day for the book page's History rows. */
export function formatShortDay(date: Date, locale: string = getLocale()): string {
  return (
    format(date, 'shortDay', { weekday: 'short', day: 'numeric', month: 'short' }, locale) ??
    localIsoDay(date)
  );
}
