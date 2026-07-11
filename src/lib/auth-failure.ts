import type { ServerInfo } from '@/api/types';

// Dead-token DETECTION (the 401-only rule and why 403/network failures don't count)
// lives on the ApiClient's `onAuthError` callback - see `client.ts`. This module keeps
// only the success-side helpers the React Query cache uses: resolving which connection
// a key belongs to (to CLEAR a flag) and spotting a server reset from a `/server` response.

/**
 * The connection id a React Query key belongs to: the first known connection id present
 * anywhere in the key. Every scoped key is tagged with its connection id (see `qk.*`), but
 * not always at a fixed index (some keys lead with a resource name, e.g.
 * `['progress','all',cid]`), so we match by membership against the live id list - the same
 * approach the cache-eviction predicate in `provider.tsx` uses. Used by the query cache's
 * success handler to CLEAR a reconnect flag on the right connection. Returns null for a
 * global/unscoped key (no known id present).
 */
export function connectionIdFromKey(
  key: readonly unknown[],
  knownIds: readonly string[],
): string | null {
  for (const part of key) {
    if (typeof part === 'string' && knownIds.includes(part)) return part;
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
