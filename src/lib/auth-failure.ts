import { ApiError } from '@/api/client';
import type { ServerInfo } from '@/api/types';

/**
 * Whether a thrown error is a "dead token" signal: the server *answered* an
 * authenticated request and rejected our credential itself (HTTP **401 only**).
 * Because `ApiClient` only throws `ApiError` for real HTTP responses (a
 * network/offline failure throws a `TimeoutError` or a raw fetch rejection, with no
 * status), a 401 `ApiError` inherently proves the server responded and refused the
 * token - cleanly distinct from "offline". The reachability layer relies on the same
 * invariant (an `ApiError` means the server is reachable).
 *
 * **403 is deliberately excluded.** On audiosilo-server a 403 means "valid token,
 * but forbidden" - a share/scope denial (`handlers_library.go` "no access to this
 * library"/"no access to this path", a routine event when a scoped user browses
 * outside their share), "admin only", or an api-key/demo restriction. The token is
 * perfectly good in every one of those cases. A genuinely dead/invalid/revoked token
 * ALWAYS yields 401 (`middleware.go` "missing bearer token" / "invalid or expired
 * token"). Treating a 403 as a dead token would spuriously tell a correctly-logged-in
 * shared user to reconnect just for hitting a forbidden path - the exact false-positive
 * logout this feature exists to prevent.
 */
export function isDeadTokenError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

/**
 * The connection id a React Query / mutation key belongs to: the first known
 * connection id present anywhere in the key. Every scoped key is tagged with its
 * connection id (see `qk.*`), but not always at a fixed index (some keys lead with
 * a resource name, e.g. `['progress','all',cid]`), so we match by membership against
 * the live id set - the same approach the cache-eviction predicate in `provider.tsx`
 * uses. Returns null for a global/unscoped key (no known id present).
 */
export function connectionIdFromKey(
  key: readonly unknown[],
  knownIds: Iterable<string>,
): string | null {
  const ids = knownIds instanceof Set ? knownIds : new Set(knownIds);
  for (const part of key) {
    if (typeof part === 'string' && ids.has(part)) return part;
  }
  return null;
}

/**
 * Whether a React Query key is a `qk.server(cid)` key (shape `['server', cid]`). The
 * single owner of the `'server'` literal - `useServerInfo()` is the only unauthenticated
 * (public `/server`) query, so this is how the cache layer tells that success apart from
 * an authenticated one.
 */
export function isServerInfoKey(key: readonly unknown[]): boolean {
  return key[0] === 'server';
}

/**
 * The connection id to flag as `server-reset`, given a `/server` response for a known
 * connection key. If the server now reports a different `server_id` than the connection's
 * id, the install was rebuilt from scratch - this identity is gone, so re-pairing is
 * required. Piggybacks on the existing `useServerInfo()` fetch (no dedicated poller).
 * Returns null when the key isn't a server key or the id still matches (nothing to flag).
 */
export function serverResetCid(key: readonly unknown[], data: unknown): string | null {
  if (!isServerInfoKey(key)) return null;
  const cid = typeof key[1] === 'string' ? key[1] : null;
  const serverId = (data as ServerInfo | undefined)?.server_id;
  if (cid && typeof serverId === 'string' && serverId && serverId !== cid) return cid;
  return null;
}
