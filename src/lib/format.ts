import { getLocale } from '@/i18n/locale';
import { parseHhMm } from '@/lib/hhmm';

/** "12h 30m" / "45m" / "30s" - compact total-duration label. */
export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

/** "1:02:03" / "2:05" - transport clock. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "1.2 GB" / "340 MB" / "12 KB" - human-readable file size. The number is
 * locale-formatted (e.g. "1,2 GB" in de); the unit symbols are universal. */
export function formatBytes(bytes?: number, locale: string = getLocale()): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  const maxFractionDigits = v >= 100 || i === 0 ? 0 : 1;
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: maxFractionDigits }).format(v);
  return `${n} ${units[i]}`;
}

/** "3,249" - a whole count in the reader's locale ("3.249" in de). */
export function formatCount(n: number, locale: string = getLocale()): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n);
}

/** "128kbps" from a file's bytes + seconds; empty when not derivable. */
export function formatBitrate(sizeBytes?: number, durationSec?: number): string {
  if (!sizeBytes || !durationSec || durationSec <= 0) return '';
  const kbps = Math.round((sizeBytes * 8) / durationSec / 1000);
  return kbps > 0 ? `${kbps}kbps` : '';
}

/** "8m52s" / "1h33m" / "45s" - compact spoken-style duration (per old client). */
export function formatDurationFull(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  const t = Math.round(seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

/** "5m 12s" / "1h 5m" / "45s" - the two most-significant units of a short
 * duration, spaced. Used by the sleep timer's end-of-chapter countdown list. */
export function formatCountdown(seconds: number): string {
  const t = Math.max(0, Math.round(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** "now" / "3 days ago" / "2 months ago" - coarse relative time from an RFC3339
 * timestamp. Uses `Intl.RelativeTimeFormat` (locale-formatted, `numeric: 'auto'`
 * yields "yesterday"/"last month") where available - web and Node - but Hermes
 * (React Native) does NOT ship `Intl.RelativeTimeFormat`, so we fall back to a
 * plain English formatter rather than crashing. Empty when the input is missing
 * or unparseable. */
export function formatRelative(iso?: string, locale: string = getLocale()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const sec = Math.max(0, (Date.now() - then) / 1000);
  // Construct the formatter only when the API exists (absent on Hermes/RN).
  const rtf =
    typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function'
      ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
      : null;
  if (sec < 45) return rtf ? rtf.format(0, 'second') : 'just now';
  const units: [limit: number, secs: number, unit: Intl.RelativeTimeFormatUnit][] = [
    [60, 1, 'second'],
    [3600, 60, 'minute'],
    [86400, 3600, 'hour'],
    [2592000, 86400, 'day'],
    [31536000, 2592000, 'month'],
    [Infinity, 31536000, 'year'],
  ];
  for (const [limit, secs, unit] of units) {
    if (sec < limit) {
      const n = Math.max(1, Math.round(sec / secs));
      return rtf ? rtf.format(-n, unit) : `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    }
  }
  return '';
}

/**
 * Cached `Intl.DateTimeFormat`s for `formatTimeOfDay`, keyed by locale. Under
 * Hermes every construction bridges to the platform formatter, and a single
 * stepper tap re-renders every clock readout on the settings screen - walking a
 * window bound across the evening is dozens of taps, so building one formatter
 * per call is measurably wasteful for a value that never changes.
 */
const timeOfDayFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A canonical "HH:MM" rendered in the reader's own clock convention (so an en-US
 * reader sees "10:00 PM" where a de reader sees "22:00"). Falls back to the stored
 * 24h form if the runtime has no usable `Intl.DateTimeFormat` - Hermes ships a
 * reduced Intl, and a clock label is not worth a crash.
 *
 * The instant and the formatter are both pinned to UTC. The value is a bare wall-clock
 * time with no date and no zone, so the two only have to agree with EACH OTHER - and a
 * formatter resolves the device zone once, when it is constructed and cached, while a
 * `new Date(y, m, d, h, m)` re-reads the live zone on every call. Someone whose zone
 * changed under a long-lived JS context (travel) would otherwise see their 22:00 bound
 * rendered as "3:00 AM". Pinning both sides makes the pair immune to that.
 */
export function formatTimeOfDay(hhmm: string, locale: string = getLocale()): string {
  const minutes = parseHhMm(hhmm);
  if (minutes === null) return hhmm;
  try {
    let fmt = timeOfDayFormatters.get(locale);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat(locale, {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'UTC',
      });
      timeOfDayFormatters.set(locale, fmt);
    }
    return fmt.format(new Date(Date.UTC(2000, 0, 1, Math.floor(minutes / 60), minutes % 60)));
  } catch {
    return hhmm;
  }
}

/** Author / series line for a book, skipping empty parts. */
export function bookSubtitle(opts: {
  author?: string;
  series?: string;
  seriesIndex?: number;
}): string {
  const parts: string[] = [];
  if (opts.author) parts.push(opts.author);
  if (opts.series) {
    parts.push(opts.seriesIndex ? `${opts.series} #${opts.seriesIndex}` : opts.series);
  }
  return parts.join(' · ');
}
