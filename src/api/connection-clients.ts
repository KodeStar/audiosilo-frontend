import { useSession } from '@/stores/session';

import { ApiClient } from './client';

/**
 * The seam that lets framework-free modules (progress-sync, the downloads store)
 * resolve a connection id to its `ApiClient` without importing React or the provider.
 * Everything reads straight from the session Zustand store via `useSession.getState()`.
 */

/**
 * The `ApiClient` for a connection id, or null when that connection no longer
 * exists. Built fresh per call - the client is a stateless holder of
 * (serverUrl, token), so this always reflects the current token with nothing
 * to invalidate.
 */
export function resolveClient(connectionId: string): ApiClient | null {
  const conn = useSession.getState().connections.find((c) => c.id === connectionId);
  return conn ? new ApiClient(conn.serverUrl, conn.token) : null;
}

/** Whether the session store has finished hydrating (so the connection list is real).
 * The offline replay flush gates on this: a flush racing hydrate would resolve every
 * entry's client to null and drop the queue as unroutable. */
export function sessionReady(): boolean {
  return useSession.getState().status !== 'loading';
}
