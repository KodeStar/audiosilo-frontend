import { ApiError } from '@/api/client';

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
