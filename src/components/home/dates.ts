import { getLocale } from '@/i18n/locale';

/**
 * Home's dates in the reader's locale: the greeting's "Monday 5 October" and the short
 * "20 Oct" of finish dates. Hermes ships a reduced Intl, so each falls back to the ISO
 * date rather than throwing; formatters are cached per locale (a Hermes construction
 * bridges to the platform each time).
 */

const cache = new Map<string, Intl.DateTimeFormat>();

function format(date: Date, key: string, opts: Intl.DateTimeFormatOptions, locale: string) {
  try {
    const id = `${locale}|${key}`;
    let fmt = cache.get(id);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat(locale, opts);
      cache.set(id, fmt);
    }
    return fmt.format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** "Monday 5 October" (the device's own date; the greeting is about the listener's day). */
export function formatLongDate(date: Date, locale: string = getLocale()): string {
  return format(date, 'long', { weekday: 'long', day: 'numeric', month: 'long' }, locale);
}

/** "20 Oct". */
export function formatDayMonth(date: Date, locale: string = getLocale()): string {
  return format(date, 'dm', { day: 'numeric', month: 'short' }, locale);
}

/** "20 Oct" for a server `YYYY-MM-DD` day, read as that calendar day (not shifted into
 * the device's zone). */
export function formatServerDay(day: string, locale: string = getLocale()): string {
  return format(
    new Date(`${day}T12:00:00Z`),
    'sdm',
    { day: 'numeric', month: 'short', timeZone: 'UTC' },
    locale,
  );
}
