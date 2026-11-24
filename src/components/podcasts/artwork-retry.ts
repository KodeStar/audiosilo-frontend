import { ApiError, isRefusedForGood } from '@/api/client';

/**
 * When a directory result's artwork tries again after it failed to load (Bridge Phase
 * 2d-2, fe#126). The server fetches uncached images only a few at a time, so a full results
 * list can get 429 / 503 for some. An image element can't see the status, and the route
 * takes no extra parameter (no cache buster) and answers HEAD 405, so a failed load asks
 * the same URL once with GET (`probeArtwork`) and the image mounts again with that URL:
 * at once when the probe got the image, never when the artwork is gone (an id that expired
 * is a 404 every time), and otherwise after 3 s, 10 s and 30 s, or the server's longer
 * `Retry-After` when it was turned away with one (never a shorter one: a busy server's 1 s
 * would spend all four tries within seconds of the spike they are for). Four tries in all,
 * then it keeps the placeholder.
 */
export const ARTWORK_RETRY_DELAYS_MS = [3_000, 10_000, 30_000] as const;

/** The longest a `Retry-After` holds the next try (a busy page should not wait minutes). */
const MAX_RETRY_AFTER_MS = 60_000;

/** What asking the artwork's URL again answered: the image (`ready`), a wait the server
 * asked for, a refusal no wait mends (`gone`: a 404, an expired token), or nothing usable
 * (no answer, a 5xx, a 429 / 503 whose `Retry-After` the browser can't read). */
export type ArtworkProbe =
  { kind: 'ready' } | { kind: 'wait'; seconds: number } | { kind: 'gone' } | { kind: 'unknown' };

/** Ask `url` once (`probe`, the client's `probeDiscoveryArtwork`) and read the answer. */
export async function probeArtwork(probe: () => Promise<void>): Promise<ArtworkProbe> {
  try {
    await probe();
    return { kind: 'ready' };
  } catch (e) {
    if (!(e instanceof ApiError)) return { kind: 'unknown' };
    if (e.status === 429 || e.status === 503) {
      return e.retryAfterSeconds === undefined
        ? { kind: 'unknown' }
        : { kind: 'wait', seconds: e.retryAfterSeconds };
    }
    return isRefusedForGood(e) ? { kind: 'gone' } : { kind: 'unknown' };
  }
}

/** The wait before the next try after `failures` failed tries, or null: stop trying.
 * `probe` is what asking the URL again answered; without one (or one that says nothing)
 * the fixed schedule stands. */
export function artworkRetryDelay(failures: number, probe?: ArtworkProbe): number | null {
  const scheduled = failures >= 1 ? (ARTWORK_RETRY_DELAYS_MS[failures - 1] ?? null) : null;
  if (scheduled === null) return null;
  switch (probe?.kind) {
    case 'ready':
      return 0;
    case 'gone':
      return null;
    case 'wait':
      // The tries are few: a wait shorter than the schedule's would spend them in a burst.
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(scheduled, probe.seconds * 1_000));
    default:
      return scheduled;
  }
}
