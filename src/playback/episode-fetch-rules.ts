import type { Book, PodcastFetchStatus } from '@/api/types';

/**
 * The rules an episode's server fetch follows, shared by the player's fetch
 * (`episode-fetch.ts`) and the downloads store's wait for an episode not on its server yet
 * (`downloads/episode-ready.ts`). Framework-free and import-light: the downloads store loads
 * at launch and must not pull in the player's start path.
 */

/** Whether `book` is an episode whose file is not on its server (yet). */
export function isAbsentEpisode(book: Book): boolean {
  return !!book.episode && !book.episode.downloaded;
}

/** The poll interval floor, seconds (the server's `Retry-After`). */
const MIN_POLL_S = 2;
/** The longest wait between two looks while the server keeps failing (5xx, no answer). */
const MAX_BLIP_POLL_S = 60;

/** The wait before the next look at a fetch on its way: the server's `seconds`, never under
 * the floor (an answer without a usable number waits the floor). */
export function pollDelay(seconds: number): number {
  return Math.max(MIN_POLL_S, Number.isFinite(seconds) ? seconds : 0);
}

/** The wait before the next look after `blips` failed looks in a row: doubling from the
 * floor, at most `MAX_BLIP_POLL_S`, and never under the answer's `Retry-After`. */
export function blipDelay(blips: number, retryAfter?: number): number {
  const backoff = Math.min(MAX_BLIP_POLL_S, MIN_POLL_S * 2 ** Math.max(0, blips - 1));
  return Math.max(backoff, retryAfter ?? 0);
}

/** The share of a fetch done (0..100, whole) when the server knows the size, else null. */
export function fetchPercent(status: PodcastFetchStatus | null | undefined): number | null {
  const total = status?.bytes_total ?? null;
  if (total === null || total <= 0) return null;
  const received = Math.max(0, status?.bytes_received ?? 0);
  return Math.min(100, Math.floor((received / total) * 100));
}
