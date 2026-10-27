/**
 * When a directory result's artwork tries again after it failed to load (Bridge Phase
 * 2d-2). The server fetches uncached images only a few at a time, so a full results list
 * can get 429 / 503 for some; an image element can't see the status, and the route takes
 * no extra parameter (no cache buster), so the image is mounted again with the same URL
 * after 3 s, 10 s and 30 s (four tries in all), then keeps the placeholder (an id that
 * expired is a 404 every time).
 */
export const ARTWORK_RETRY_DELAYS_MS = [3_000, 10_000, 30_000] as const;

/** The wait before the next try after `failures` failed tries, or null: stop trying. */
export function artworkRetryDelay(failures: number): number | null {
  return failures >= 1 ? (ARTWORK_RETRY_DELAYS_MS[failures - 1] ?? null) : null;
}
