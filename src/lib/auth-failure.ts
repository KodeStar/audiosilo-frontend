import type { ServerInfo } from '@/api/types';
import { serverIdOf } from '@/lib/connection-id';

// Dead-token DETECTION (the 401-only rule and why 403/network failures don't count)
// lives on the ApiClient's `onAuthError` callback - see `client.ts`. This module keeps
// the cache key helpers and the identity check used when the connection's /server answers.

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

/** A connection's `/server` query key (`qk.server`), for a reader below the hooks. */
export function serverInfoKey(cid: string) {
  return ['server', cid] as const;
}

/** The install that answered /server, when the response identifies one. */
export function reportedServerId(data: unknown): string | undefined {
  const id = (data as Partial<ServerInfo> | null)?.server_id;
  return typeof id === 'string' && id.trim() ? id : undefined;
}

/**
 * The connection id to flag as `server-reset`, given a `/server` response for a known
 * connection key. If the server now reports a different `server_id` than the connection's
 * server (`serverIdOf`: never the connection id itself, which also names the user), the
 * answer names another install. Only a current paired or away address can prove that
 * the server was reset (`acceptsServerAnswer`). Returns null when
 * the key isn't a server key or the id still matches (nothing to flag). `connections` are
 * the signed-in ones (their `serverId`); a key naming none of them is read by its id alone
 * (`parseConnectionId`).
 */
export function serverResetCid(
  key: readonly unknown[],
  data: unknown,
  connections: readonly { id: string; serverId?: string }[] = [],
): string | null {
  if (!isServerInfoKey(key)) return null;
  const cid = typeof key[1] === 'string' ? key[1] : null;
  const serverId = reportedServerId(data);
  if (!cid || !serverId) return null;
  const conn = connections.find((c) => c.id === cid) ?? { id: cid };
  return serverId !== serverIdOf(conn) ? cid : null;
}

/** Whether a `/server` answer kept for the connection `key` names can't be taken as its
 * own: it names no install, or another one (`serverResetCid`). Kept answers are read
 * without the address that gave them, so neither case flags the connection. */
export function foreignServerAnswer(
  key: readonly unknown[],
  data: unknown,
  connections: readonly { id: string; serverId?: string }[] = [],
): boolean {
  return !reportedServerId(data) || serverResetCid(key, data, connections) !== null;
}
