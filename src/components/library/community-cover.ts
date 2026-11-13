import type { ApiClient } from '@/api/client';
import type { CoverSize } from '@/api/types';

/** A community cover's image source: a URL, or a URL of the server's with the connection's
 * proxy headers (fe#167). */
export type CommunityCover = string | { uri: string; headers: Record<string, string> };

/** What to load for a community `cover_url` (a series rail entry's, a previous book's)
 * at `size`: a source, or null for the cover's placeholder. */
export type CommunityCoverFor = (
  coverUrl: string | undefined,
  size: CoverSize,
) => CommunityCover | null;

/** No community cover at all: every one shows its placeholder. */
export const noCommunityCover: CommunityCoverFor = () => null;

/**
 * Where a community cover loads from. A server with `meta_covers` serves it itself
 * (`client.communityCoverUrl`), so the device never contacts the cover's host. Without
 * it, native loads the `cover_url` directly as it always has, but the web player can't
 * (its CSP takes images only from the server: the request would be blocked and logged),
 * so it shows the placeholder. While the capability is unknown nothing loads yet, so
 * a cover is never fetched twice. The server's own URL goes with the connection's proxy
 * headers when it is behind an auth proxy (fe#167, `proxyHeadersFor`: the app only, the
 * web's `<img>` sends none); the cover's own host never gets a header.
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
}): CommunityCover | null {
  const { coverUrl, size, proxied, web, api, libraryId, path } = opts;
  if (!coverUrl) return null;
  if (proxied) {
    if (!api) return null;
    const uri = api.communityCoverUrl(libraryId, path, coverUrl, { size });
    const headers = web ? undefined : api.proxyHeadersFor(uri);
    return headers ? { uri, headers } : uri;
  }
  return proxied === false && !web ? coverUrl : null;
}
