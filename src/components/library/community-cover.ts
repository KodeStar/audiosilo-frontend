import type { ApiClient } from '@/api/client';
import type { CoverSize } from '@/api/types';

/** What to load for a community `cover_url` (a series rail entry's, a previous book's)
 * at `size`: a URL, or null for the cover's placeholder. */
export type CommunityCoverFor = (coverUrl: string | undefined, size: CoverSize) => string | null;

/** No community cover at all: every one shows its placeholder. */
export const noCommunityCover: CommunityCoverFor = () => null;

/**
 * Where a community cover loads from. A server with `meta_covers` serves it itself
 * (`client.communityCoverUrl`), so the device never contacts the cover's host. Without
 * it, native loads the `cover_url` directly as it always has, but the web player can't
 * (its CSP takes images only from the server: the request would be blocked and logged),
 * so it shows the placeholder. While the capability is unknown nothing loads yet, so
 * a cover is never fetched twice.
 */
export function communityCoverSource(opts: {
  coverUrl: string | undefined;
  size: CoverSize;
  /** The server's `meta_covers` flag (undefined while unknown). */
  proxied: boolean | undefined;
  web: boolean;
  api: ApiClient | null;
  /** The book whose `/meta` envelope handed out the cover. */
  libraryId: number;
  path: string;
}): string | null {
  const { coverUrl, size, proxied, web, api, libraryId, path } = opts;
  if (!coverUrl) return null;
  if (proxied === true) {
    return api ? api.communityCoverUrl(libraryId, path, coverUrl, { size }) : null;
  }
  if (proxied === false && !web) return coverUrl;
  return null;
}
