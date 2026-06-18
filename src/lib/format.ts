/** "12h 30m" / "45m" / "30s" — compact total-duration label. */
export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

/** "1:02:03" / "2:05" — transport clock. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "1.2 GB" / "340 MB" / "12 KB" — human-readable file size. */
export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** "128kbps" from a file's bytes + seconds; empty when not derivable. */
export function formatBitrate(sizeBytes?: number, durationSec?: number): string {
  if (!sizeBytes || !durationSec || durationSec <= 0) return '';
  const kbps = Math.round((sizeBytes * 8) / durationSec / 1000);
  return kbps > 0 ? `${kbps}kbps` : '';
}

/** "8m52s" / "1h33m" / "45s" — compact spoken-style duration (per old client). */
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

/** "just now" / "3 days ago" / "2 months ago" — coarse relative time from an
 * RFC3339 timestamp. Empty when the input is missing or unparseable. */
export function formatRelative(iso?: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const sec = Math.max(0, (Date.now() - then) / 1000);
  const units: [limit: number, secs: number, name: string][] = [
    [60, 1, 'second'],
    [3600, 60, 'minute'],
    [86400, 3600, 'hour'],
    [2592000, 86400, 'day'],
    [31536000, 2592000, 'month'],
    [Infinity, 31536000, 'year'],
  ];
  if (sec < 45) return 'just now';
  for (const [limit, secs, name] of units) {
    if (sec < limit) {
      const n = Math.max(1, Math.round(sec / secs));
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return '';
}

/** Author / series line for a book, skipping empty parts. */
export function bookSubtitle(opts: { author?: string; series?: string; seriesIndex?: number }): string {
  const parts: string[] = [];
  if (opts.author) parts.push(opts.author);
  if (opts.series) {
    parts.push(opts.seriesIndex ? `${opts.series} #${formatSeriesIndex(opts.seriesIndex)}` : opts.series);
  }
  return parts.join(' · ');
}

function formatSeriesIndex(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}
