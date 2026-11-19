import { resolveConnectionId } from '@/lib/connection-id';
import { connectionSetFor, type ProxyHeaders, sameProxyHeaders } from '@/lib/proxy-headers';
import { type Connection, sessionHydrateFailed, useSession } from '@/stores/session';

import { effectiveUrl } from './address-route';
import { ApiClient } from './client';
import { noteProxyAnswer, useProxyRefusals } from './proxy-refusal';
import { noteAnswer } from './reachability';
import type { Capabilities } from './types';

/**
 * The seam that lets framework-free modules (progress-sync, the downloads store)
 * resolve a connection id to its `ApiClient` without importing React or the provider.
 * Everything reads straight from the session Zustand store via `useSession.getState()`.
 */

/** A connection's server flags as the app holds them now, undefined while not known. */
type KnownCapabilities = (connectionId: string) => Capabilities | undefined;

let knownCapabilities: KnownCapabilities = () => undefined;

/**
 * Where a connection's client reads its server's flags from: the query cache's `/server`
 * answer (`provider.tsx`, the one copy: `server-snapshots.ts`), handed in because this
 * module is below the provider. Read without a request, and unknown until it is set.
 */
export function readKnownCapabilitiesFrom(read: KnownCapabilities): void {
  knownCapabilities = read;
}

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
 * carries the token and the proxy headers kept for `url`'s origin (fe#167, `connectionSetFor`:
 * or its sign-in's own, `signInProxySets`), and
 * injects the dead-token callback, so a 401 on ANY request through it (query or mutation, on
 * screen or in the save loop) flags the connection for reconnect: the client is the one choke
 * point every request path shares. Not once the connection holds another token (a re-pair): a
 * client built before it is stale, and the connection's sign-in is not dead. Every answer it
 * gets counts for reachability (`noteAnswer`, FU-SLOWOK), by the address it came from, and
 * tells whether a proxy in front of the server is turning the connection away
 * (`noteProxyAnswer`: the shell's notice, never a sign-out). A 401 is read by what the
 * connection's last `/server` answer said of the server's mark (`unauthorized_mark`,
 * WS-401-MARK): once the server is known to mark its 401s, one without the mark to a request
 * that carried proxy headers is never its own.
 */
export function connectionClient(
  conn: Connection,
  url: string,
  proxy: ProxyHeaders | null = connectionProxyFor(conn.id, url),
): ApiClient {
  return new ApiClient(
    url,
    conn.token,
    undefined,
    () => {
      // Only while the connection still holds this token: a request sent before a re-pair
      // that comes back 401 after it says nothing of the new token. Flagged under its id now
      // (a client built before the identity migration moved it names the old one).
      const now = connectionOf(conn.id);
      if (now?.token === conn.token) useSession.getState().markNeedsReconnect(now.id, 'auth');
    },
    // Under the connection's id now, as the 401 above: a client built before the identity
    // migration moved it names the old one, which no reachability reader asks for.
    (at) => noteAnswer(connectionOf(conn.id)?.id ?? conn.id, at),
    proxy,
    // Under its id now, as above; a connection no longer signed in has nothing to say. Only
    // while the connection still sends these headers there: a request sent with a set since
    // replaced (a grown-up's update) that answers late says nothing of the one it sends now,
    // and would raise the notice again after the new set got through. Nearly every answer is
    // the server's own with no episode to end: that one stops at the first check.
    (refused) => {
      const now = connectionOf(conn.id);
      if (!now || (!refused && !useProxyRefusals.getState().refused[now.id])) return;
      if (sameProxyHeaders(connectionProxyFor(now.id, url), proxy)) {
        noteProxyAnswer(now.id, refused);
      }
    },
    // Under its id now, as above. What the cache holds, never a request.
    () => knownCapabilities(connectionOf(conn.id)?.id ?? conn.id)?.unauthorized_mark,
  );
}

/** The proxy headers a request of the connection `connectionId` to `url` carries now
 * (`connectionSetFor`: the set kept for that origin, or its sign-in's own). */
export function connectionProxyFor(connectionId: string, url: string): ProxyHeaders | null {
  const { proxySets, signInProxySets } = useSession.getState();
  return connectionSetFor(proxySets, url, signInProxySets[connectionId]);
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

/** Run `fn` once, as soon as the session is ready (`sessionReady`): now when it is, else on
 * the first store change that makes it so (a hydrate that failed and then succeeded too, which
 * never passes through `loading` again). The callback form of `offline-meta.ts`'s
 * `whenSessionReady`. Returns the stop (a no-op once `fn` ran). */
export function whenSessionReady(fn: () => void): () => void {
  if (sessionReady()) {
    fn();
    return () => undefined;
  }
  const stop = useSession.subscribe(() => {
    if (!sessionReady()) return;
    stop();
    fn();
  });
  return stop;
}
