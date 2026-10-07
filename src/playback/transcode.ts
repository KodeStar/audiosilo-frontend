import type { Book, ChaptersResponse } from '@/api/types';

/**
 * Web transcode negotiation (CROSS-REPO.md section 5): the pure rules. A browser can't
 * decode some codecs a book may use (AC-3, ALAC, WMA...); the server marks those books
 * `direct_playable: false` and, when it has ffmpeg (`capabilities.transcode`), streams
 * them re-encoded to MP3 with `?transcode=1&t=<seconds>`. That output is NOT
 * byte-seekable and its length is unknown to the media element, so the web engine
 * re-requests the stream at a new `t` on every seek and keeps the track-absolute
 * position itself (`transcodedTrackPosition`).
 *
 * Native engines decode these codecs and never transcode; a downloaded (local) file is
 * never transcoded either. Everything here is framework-free so the rules are testable.
 */

/** Does the server say this book's codec won't play directly in a browser? Only an
 * explicit `false` counts: an older server omits the field (and an unprobed codec reads
 * as playable), and those must stream exactly as they always did. The chapters
 * response is preferred when it carries the flag (it is fetched fresh for playback). */
export function isBrowserUndecodable(book: Book, chapterData?: ChaptersResponse): boolean {
  return (chapterData?.direct_playable ?? book.direct_playable) === false;
}

/**
 * The one rule for whether a book streams through the server's transcoder: on web,
 * for a book the server marked undecodable, when that book's server advertises the
 * `transcode` capability. An unknown capability (`undefined`, its `/server` not loaded)
 * reads as no: stream directly, exactly as before negotiation existed (the browser may
 * still play it, and the error/retry path surfaces it if not).
 */
export function needsWebTranscode(
  os: string,
  book: Book,
  chapterData: ChaptersResponse | undefined,
  canTranscode: boolean | undefined,
): boolean {
  return os === 'web' && canTranscode === true && isBrowserUndecodable(book, chapterData);
}

/**
 * The transcoded stream URL starting `t` seconds into the file: replaces any `t` the
 * URL already carries (every other query param, the media token included, is kept
 * verbatim) and drops it at 0 (the server starts at the top without one, which is
 * also how `client.streamUrl` builds it). Millisecond precision is plenty for ffmpeg's
 * `-ss` and keeps the URL short.
 */
export function transcodeUrlAt(url: string, t: number): string {
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const params = (q < 0 ? '' : url.slice(q + 1))
    .split('&')
    .filter((p) => p !== '' && !p.startsWith('t='));
  if (Number.isFinite(t) && t > 0) params.push(`t=${Math.round(t * 1000) / 1000}`);
  return params.length > 0 ? `${path}?${params.join('&')}` : path;
}

/**
 * Track-absolute position of a transcoded stream: the element's `currentTime` counts
 * from the `t` it was requested at (`offset`), so the store's whole-book math needs
 * the sum. Clamped to the known file duration, since the encoder's output can run a
 * frame or two past it, which would otherwise read as the next file's first instant
 * on the whole-book timeline.
 */
export function transcodedTrackPosition(
  currentTime: number,
  offset: number,
  duration?: number,
): number {
  const pos = Math.max(0, (Number.isFinite(currentTime) ? currentTime : 0) + offset);
  return duration != null && duration > 0 ? Math.min(pos, duration) : pos;
}

/** Clamp a seek target into a transcoded track: `[0, duration]` when the duration is
 * known (the element can't tell us; it reads Infinity/NaN for these streams). */
export function clampTranscodedSeek(position: number, duration?: number): number {
  const pos = Math.max(0, Number.isFinite(position) ? position : 0);
  return duration != null && duration > 0 ? Math.min(pos, duration) : pos;
}

/** How far before the known end of a file an `ended` counts as the stream dying rather
 * than the file finishing (seconds). */
export const EARLY_END_SLACK_S = 10;
/** A reload after an early end must play at least this far (seconds) before another
 * early end is retried again, so a file whose real audio is shorter than its probed
 * duration ends normally instead of reloading forever. */
export const EARLY_END_MIN_PROGRESS_S = 5;

/**
 * Whether an `ended` on a transcoded stream is the connection dying (the server or a
 * proxy closed it, which an unsized stream reports as a normal end) rather than the
 * file finishing - then the engine reloads at `position` instead of advancing. Needs a
 * known duration; `lastRetryAt` is the position the previous early-end reload started
 * from (null if none), and a stream that ends again without real progress past it is
 * accepted as finished.
 */
export function isEarlyTranscodeEnd(
  position: number,
  duration: number | undefined,
  lastRetryAt: number | null,
): boolean {
  if (duration == null || !(duration > 0)) return false;
  if (position >= duration - EARLY_END_SLACK_S) return false;
  return lastRetryAt == null || position - lastRetryAt >= EARLY_END_MIN_PROGRESS_S;
}

/** After a pause this long (ms), resuming a transcoded stream re-requests it at the
 * current position instead of resuming the old connection: a paused, back-pressured
 * transcode can be dropped by the server or a proxy, and a resume on a dead
 * connection would only stall into the watchdog's error. */
export const TRANSCODE_STALE_PAUSE_MS = 30_000;

/** Display names for the ffprobe codec names a browser can't decode, for the book
 * page's "converted for this browser" line. Anything unlisted shows upper-cased. */
const CODEC_LABELS: Record<string, string> = {
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  alac: 'ALAC',
  dts: 'DTS',
  truehd: 'TrueHD',
  wmav1: 'WMA',
  wmav2: 'WMA',
  wmapro: 'WMA Pro',
  amr_nb: 'AMR',
  amr_wb: 'AMR-WB',
};

/** A human label for a codec (`''` when unknown, so the caller picks generic copy). */
export function codecLabel(codec: string | undefined): string {
  const c = (codec ?? '').trim().toLowerCase();
  if (!c) return '';
  return CODEC_LABELS[c] ?? c.toUpperCase();
}
