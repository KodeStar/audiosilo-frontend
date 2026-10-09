import { resolveConnectionId } from '@/lib/connection-id';
import { type Connection, sessionHydrateFailed, useSession } from '@/stores/session';

import { effectiveUrl } from './address-route';
import { ApiClient } from './client';

/**
 * The seam that lets framework-free modules (progress-sync, the downloads store)
 * resolve a connection id to its `ApiClient` without importing React or the provider.
 * Everything reads straight from the session Zustand store via `useSession.getState()`.
 */

/**
 * The `ApiClient` for a connection id, or null when that connection no longer
 * exists. Built fresh per call - the client is a stateless holder of
 * (address, token), so this always reflects the current token and the address in use
 * now (home or away, `effectiveUrl`) with nothing to invalidate. An old id the identity
 * migration moved (`resolveConnectionId`) resolves to its connection too: a record that
 * still names it (an offline save, a car bookmark) must reach its server, never be dropped
 * as unroutable.
 */
export function resolveClient(connectionId: string): ApiClient | null {
  const conn = connectionOf(connectionId);
  if (!conn) return null;
  // Inject the dead-token callback so a 401 from the framework-free progress-sync save
  // loop (which resolves its client here) flags this connection for reconnect too - the
  // same detection every provider-built client gets, so no request path is a blind spot.
  return new ApiClient(effectiveUrl(conn), conn.token, undefined, () =>
    useSession.getState().markNeedsReconnect(conn.id, 'auth'),
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
