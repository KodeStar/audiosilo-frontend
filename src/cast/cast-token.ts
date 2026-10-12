import type { CastToken } from '@/api/types';
import { contentKey, isKeyOf } from '@/lib/content-key';

/**
 * Cast tokens (capability `cast`, `POST /cast/token`): the receiver never gets the session
 * token. The server mints a short-lived (24 h), book-scoped, media-only token instead, and
 * the receiver's stream and cover URLs carry that. One is reused for its book until an hour
 * before it expires (a receiver still has to fetch the later files and seeks of a long book
 * with it), then a fresh one is minted. In memory only: a relaunch mints again, which is
 * cheap, and nothing durable ever holds a token.
 */

/** Reuse a token only while it has at least this long left (ms). */
export const CAST_TOKEN_MARGIN_MS = 60 * 60_000;

/** The one call the cache makes: `ApiClient.castToken`. */
export type CastTokenSource = { castToken(libraryId: number, path: string): Promise<CastToken> };

export type CastTokenCache = {
  /** A token for the book, cached or freshly minted. Concurrent asks for one book share one
   * request. Rejects when the server refuses or can't be reached. */
  get(
    source: CastTokenSource,
    connectionId: string,
    libraryId: number,
    path: string,
  ): Promise<string>;
  /** Forget every token of a connection (it was removed: `onConnectionRemoved`, in
   * `startCastSync`) or all of them, and any on its way for it (handed to its caller, never
   * kept). */
  clear(connectionId?: string): void;
  /** How many tokens are kept (expired ones are dropped on every `get`). */
  size(): number;
};

export function createCastTokenCache(now: () => number = Date.now): CastTokenCache {
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  const inFlight = new Map<string, Promise<string>>();
  return {
    get(source, connectionId, libraryId, path) {
      const key = contentKey(connectionId, libraryId, path);
      // Expired tokens go (a long session casts many books; nothing else would drop them).
      const at = now();
      for (const [k, v] of tokens) if (v.expiresAt <= at) tokens.delete(k);
      const known = tokens.get(key);
      if (known && known.expiresAt - now() > CAST_TOKEN_MARGIN_MS) {
        return Promise.resolve(known.token);
      }
      const pending = inFlight.get(key);
      if (pending) return pending;
      const request: Promise<string> = source
        .castToken(libraryId, path)
        .then((minted) => {
          // Its connection was cleared while it was on the way (`clear` let it go): used for
          // the load that asked, never kept.
          if (inFlight.get(key) !== request) return minted.token;
          const expiresAt = Date.parse(minted.expires_at);
          // A token whose expiry can't be read is used for this load only.
          if (Number.isFinite(expiresAt)) tokens.set(key, { token: minted.token, expiresAt });
          else tokens.delete(key);
          return minted.token;
        })
        .finally(() => {
          if (inFlight.get(key) === request) inFlight.delete(key);
        });
      inFlight.set(key, request);
      return request;
    },
    clear(connectionId) {
      for (const key of [...inFlight.keys()]) {
        if (connectionId === undefined || isKeyOf(key, connectionId)) inFlight.delete(key);
      }
      if (connectionId === undefined) {
        tokens.clear();
        return;
      }
      for (const key of [...tokens.keys()]) if (isKeyOf(key, connectionId)) tokens.delete(key);
    },
    size: () => tokens.size,
  };
}

/** The app's one cache. */
export const castTokens = createCastTokenCache();
