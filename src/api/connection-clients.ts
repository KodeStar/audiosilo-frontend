import { resolveConnectionId } from '@/lib/connection-id';
import { type ProxyHeaders, proxySetFor } from '@/lib/proxy-headers';
import { type Connection, sessionHydrateFailed, useSession } from '@/stores/session';

import { effectiveUrl } from './address-route';
import { ApiClient } from './client';
import { noteAnswer } from './reachability';

/**
 * The seam that lets framework-free modules (progress-sync, the downloads store)
 * resolve a connection id to its `ApiClient` without importing React or the provider.
 * Everything reads straight from the session Zustand store via `useSession.getState()`.
 */

/**
 * The `ApiClient` for a connection id, or null when that connection no longer
 * exists. Built fresh per call - the client is a stateless holder of
 * (address, token, proxy headers), so this always reflects the current token and the address in use
 * now (home or away, `effectiveUrl`) with nothing to invalidate. An old id the identity
 * migration moved (`resolveConnectionId`) resolves to its connection too: a record that
 * still names it (an offline save, a car bookmark) must reach its server, never be dropped
 * as unroutable.
 */
export function resolveClient(connectionId: string): ApiClient | null {
  const conn = connectionOf(connectionId);
  return conn ? connectionClient(conn, effectiveUrl(conn)) : null;
}

/**
 * A connection's client on `url` (the address it uses now, never straight from `serverUrl`),
 * the one way one is built: `resolveClient` for the framework-free modules (the progress-sync
 * save loop, the car, the downloads) and the provider's `buildClients` for every screen. It
 * carries the token and the proxy headers kept for `url`'s origin (fe#167, `proxySetFor`), and
 * injects the dead-token callback, so a 401 on ANY request through it (query or mutation, on
 * screen or in the save loop) flags the connection for reconnect: the client is the one choke point every request path shares. Every
 * answer it gets counts for reachability (`noteAnswer`, FU-SLOWOK), by the address it came from.
 */
export function connectionClient(
  conn: Connection,
  url: string,
  proxy: ProxyHeaders | null = proxySetFor(useSession.getState().proxySets, url),
): ApiClient {
  return new ApiClient(
    url,
    conn.token,
    undefined,
    () => useSession.getState().markNeedsReconnect(conn.id, 'auth'),
    (at) => noteAnswer(conn.id, at),
    proxy,
  );
}

/** The signed-in connection an id names: itself, else the connection an old id moved to
 * (`resolveConnectionId`). Undefined when neither is signed in. */
export function connectionOf(connectionId: string): Connection | undefined {
  const { connections } = useSession.getState();
  return (
    connections.find((c) => c.id === connectionId) ??
    connections.find((c) => c.id === resolveConnectionId(connectionId))
  );
}

/** Whether the session store has finished hydrating (so the connection list is real).
 * The offline replay flush gates on this: a flush racing hydrate would resolve every
 * entry's client to null and drop the queue as unroutable. So would one after a hydrate
 * that failed (the list never loaded: `sessionHydrateFailed`), until one succeeds. */
export function sessionReady(): boolean {
  return useSession.getState().status !== 'loading' && !sessionHydrateFailed();
}

/** Run `fn` once the session is ready (`sessionReady`): now when it is, else when it first
 * finishes loading. Returns the stop (a no-op once `fn` ran). */
export function whenSessionReady(fn: () => void): () => void {
  if (sessionReady()) {
    fn();
    return () => undefined;
  }
  return useSession.subscribe((state, prev) => {
    if (prev.status === 'loading' && state.status !== 'loading' && sessionReady()) fn();
  });
}
