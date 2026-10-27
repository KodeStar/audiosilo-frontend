import { type Query, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';

import { connectionIdFromKey, isServerInfoKey, serverResetCid } from '@/lib/auth-failure';
import { flushConnection } from '@/playback/progress-sync';
import { flushReadingConnection } from '@/reader/reading-progress';
import { connectionsOfProfile, useProfiles, visibleConnectionIds } from '@/stores/profiles';
import { onConnectionRemoved, useSession, type Connection } from '@/stores/session';

import { pickedUrl, useAddressRoute } from './address-route';
import { ApiClient, isSignedOutError } from './client';
import {
  anyOffline,
  noteAnswer,
  noteFailure,
  noteSuccess,
  onReconnect,
  recheckReachability,
  setReachabilityClients,
  useReachability,
} from './reachability';
import * as startupCache from './startup-cache';

// --- Dead-token / server-reset detection -----------------------------------------------
// Dead-token detection (a 401 on an authenticated request ⇒ re-pair) rides on the
// ApiClient itself: each per-connection client is built with an `onAuthError` callback
// that flags ITS connection, so EVERY request path - queries, mutations, and the
// framework-free progress-sync save loop - inherits detection at one choke point (see
// `client.ts` and `connection-clients.resolveClient`). The query cache keeps only the two
// jobs a per-call callback can't do: CLEARING a flag when an authenticated query succeeds,
// and detecting a SERVER RESET from a public `/server` response (a differing `server_id`).

/** A successful AUTHENTICATED query for a connection proves its token is alive - clear any
 * flag. The public `/server` query is skipped: it carries no auth, so its success proves
 * nothing about the token (and we use it to DETECT a server reset, below). */
function noteQuerySuccess(data: unknown, key: readonly unknown[]) {
  noteQueryReached(key);
  if (isServerInfoKey(key)) {
    // Public /server success proves nothing about the token - never clears the flag;
    // it only DETECTS a server reset (a differing server_id ⇒ re-pair required).
    const { connections, markNeedsReconnect } = useSession.getState();
    const cid = serverResetCid(key, data, connections);
    if (cid) markNeedsReconnect(cid, 'server-reset');
    return;
  }
  // Hot path: fires on EVERY successful fetch, so bail before allocating when nothing
  // is flagged (the overwhelmingly common case) - clearNeedsReconnect would just no-op.
  const { connections, clearNeedsReconnect } = useSession.getState();
  if (!connections.some((c) => c.needsReconnect)) return;
  const cid = cidOfKey(key);
  if (cid) clearNeedsReconnect(cid);
}

/** The connection a query key belongs to, among the signed-in ones. */
function cidOfKey(key: readonly unknown[]): string | null {
  return connectionIdFromKey(
    key,
    useSession.getState().connections.map((c) => c.id),
  );
}

/**
 * A query that could not reach its server (no answer: the fetch failed or timed out) has
 * the server checked (`noteFailure`): only a `/server` that does not answer either
 * marks the connection unreachable, so the chrome names it, the probe watches for it, and
 * its queries refetch once it is back (`onReconnect`, below; frontend#131). One slow or
 * broken query alone never does. An answer (an `ApiError`, a 401 included) or anything
 * else (a capability gate, a cancel) says nothing about reachability.
 */
function noteQueryError(error: unknown, key: readonly unknown[]) {
  const cid = cidOfKey(key);
  if (cid) noteFailure(cid, error);
}

/** A query that succeeded for a server marked down has it checked at once, so a Retry
 * that got through brings the connection back now, not at the next probe. Checked, not
 * trusted: a query can succeed from a local copy (`fetchBookProgress`'s mirror). The
 * public `/server` query is that check's own request, so its success is the answer
 * itself. Bails first when nothing is down (every successful fetch runs it). */
function noteQueryReached(key: readonly unknown[]) {
  const { online } = useReachability.getState();
  if (!anyOffline(online)) return;
  const cid = cidOfKey(key);
  if (!cid || online[cid] !== false) return;
  if (isServerInfoKey(key)) noteSuccess(cid);
  else recheckReachability(cid);
}

/**
 * The default query retry: once, except a 401 (frontend#124). A refused token stays
 * refused (the client has already flagged its connection for reconnect, and the screens
 * show one sign-in state for it), so asking again only doubles every dead request.
 */
export function retryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && !isSignedOutError(error);
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // Dead-token flagging lives on the ApiClient callback (one choke point for every
    // request path). The cache keeps what a per-call callback can't do: clearing a flag,
    // detecting a server reset, and telling reachability what a query learnt.
    onSuccess: (data, query) => noteQuerySuccess(data, query.queryKey),
    onError: (error, query) => noteQueryError(error, query.queryKey),
  }),
  defaultOptions: {
    queries: {
      retry: retryQuery,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

// Evict the removed server's cached data (every query key leads with its connection
// id). Matching by `includes(id)` could in theory also match a same-string path
// segment, but that would only evict one extra entry - harmless, it just refetches.
// Web: paint the first screens from the last visit's answers while they are asked again
// (`startup-cache.ts`); before anything renders, so the first render already has them.
startupCache.restore(queryClient);
startupCache.startSaving(queryClient);

onConnectionRemoved((id) => {
  queryClient.removeQueries({ predicate: (q) => q.queryKey.includes(id) });
  startupCache.forget(id);
});

// When a connection becomes reachable again, refetch that connection's queries (so
// screens that errored or emptied while it was offline repopulate on their own) and
// replay its queued progress saves (and its queued ebook reading places). invalidateQueries only refetches currently-observed
// queries, so this is cheap; every query key leads with its connection id, so the
// predicate scopes the refetch to the recovered server.
onReconnect((connectionId) => {
  void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes(connectionId) });
  void flushConnection(connectionId);
  void flushReadingConnection(connectionId);
});

type ApiRegistry = {
  clients: Map<string, ApiClient>;
  connections: Connection[];
};

const ApiContext = createContext<ApiRegistry>({
  clients: new Map(),
  connections: [],
});

/** A connection paired with its API client. */
export type ApiConnection = { connection: Connection; client: ApiClient };

/** A connection's client and the address and token it was built with. */
type BuiltClient = { url: string; token: string; client: ApiClient };

/**
 * Each connection's client on the address it uses now (`pickedUrl`), reusing the one in
 * `previous` while its address and token are unchanged, so a switch of one connection's
 * address (home / away) rebuilds only that connection's client: every memo keyed on
 * another connection's client (the Journal's per-server queries, a capability query's
 * function) and its in-flight reachability probe survive.
 */
export function buildClients(
  connections: readonly Connection[],
  picks: Record<string, string>,
  previous: ReadonlyMap<string, BuiltClient>,
): Map<string, BuiltClient> {
  const built = new Map<string, BuiltClient>();
  for (const c of connections) {
    const url = pickedUrl(c, picks[c.id]);
    const kept = previous.get(c.id);
    built.set(
      c.id,
      kept && kept.url === url && kept.token === c.token
        ? kept
        : {
            url,
            token: c.token,
            // Inject the dead-token callback so a 401 on ANY request through this client
            // (query OR mutation) flags this connection for reconnect - the client is the
            // one choke point every request path shares. Built on the address in use now
            // (`resolveClient` does the same), never straight from `serverUrl`.
            // Every answer it gets is counted for reachability (`noteAnswer`, FU-SLOWOK).
            client: new ApiClient(
              url,
              c.token,
              undefined,
              () => useSession.getState().markNeedsReconnect(c.id, 'auth'),
              () => noteAnswer(c.id),
            ),
          },
    );
  }
  return built;
}

/** The clients built last, by connection id: a cache (a client is a stateless holder of
 * its address and token, so handing the same one to another provider is harmless). */
const lastBuilt = new Map<string, BuiltClient>();

/** `buildClients` against the clients built last, which it then replaces. */
function connectionClients(
  connections: readonly Connection[],
  picks: Record<string, string>,
): Map<string, ApiClient> {
  const built = buildClients(connections, picks, lastBuilt);
  lastBuilt.clear();
  for (const [id, b] of built) lastBuilt.set(id, b);
  return new Map([...built].map(([id, b]) => [id, b.client]));
}

/** The lists a screen reads first for a connection (kids mode's shelf, the Household card's
 * library pick): read again with a new token even when their last answer was fine. */
const READ_AGAIN_ON_SIGN_IN = new Set(['server', 'libraries', 'collections']);

/** Whether `query`, of connection `cid` (every key carries it, though not always second),
 * is read again once that connection has a new token: whatever failed while it was signed
 * out, and the lists screens read first. */
export function readAgainOnSignIn(query: Pick<Query, 'queryKey' | 'state'>, cid: string): boolean {
  if (!query.queryKey.includes(cid)) return false;
  return query.state.status === 'error' || READ_AGAIN_ON_SIGN_IN.has(String(query.queryKey[0]));
}

/**
 * Read a connection's answers again once it has a new token (signed in again: the
 * Household page's "Sign in again", the connect flow's reconnect): what failed while it was
 * signed out would otherwise keep its error until a reload (`readAgainOnSignIn`). In the
 * provider's effect, which runs after every screen's own: the queries already hold the new
 * client (`useApiRegistry`) by then, and a read any earlier would ask with the dead token
 * and flag the connection again.
 */
function useReadAgainOnSignIn(connections: readonly Connection[]) {
  const tokens = useRef(new Map<string, string>());
  useEffect(() => {
    const seen = tokens.current;
    for (const c of connections) {
      const before = seen.get(c.id);
      seen.set(c.id, c.token);
      if (before === undefined || before === c.token) continue;
      void queryClient.invalidateQueries({ predicate: (q) => readAgainOnSignIn(q, c.id) });
    }
    for (const id of seen.keys()) {
      if (!connections.some((c) => c.id === id)) seen.delete(id);
    }
  }, [connections]);
}

export function ApiProvider({ children }: { children: ReactNode }) {
  const connections = useSession((s) => s.connections);
  // Which of each connection's addresses (home / away) requests go to right now.
  const picks = useAddressRoute((s) => s.picks);

  // Build the clients only when the connections or the picked addresses change, and then
  // only the ones whose address or token moved (`buildClients`) - re-creating a client
  // drops its in-flight reachability probe and force-refetches its queries.
  const clients = useMemo(() => connectionClients(connections, picks), [connections, picks]);

  const registry = useMemo<ApiRegistry>(() => ({ clients, connections }), [clients, connections]);

  // Give the reachability layer every connection's client, so it can probe any offline
  // server (not just the active one) and recover them independently.
  useEffect(() => {
    setReachabilityClients(registry.clients);
  }, [registry]);
  useReadAgainOnSignIn(connections);

  return (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={registry}>{children}</ApiContext.Provider>
    </QueryClientProvider>
  );
}

export function useApiRegistry(): ApiRegistry {
  return useContext(ApiContext);
}

/** The default connection id (`''` when none) - the fallback cid for chrome that isn't
 * scoped to a specific server (the top bar, the connect flow default). Internal to the
 * cid resolution order (`useCid`); consumers should use `useCid()`, not the raw default. */
function useDefaultCid(): string {
  return useSession((s) => s.defaultConnectionId) ?? '';
}

/**
 * The connection a subtree of content is scoped to (the server whose library/book you
 * are viewing), supplied by the `(app)` layout via `ConnectionScope` from the content
 * route's `?connection=` query param. `''` outside any scope (chrome, aggregated
 * Home/Search). Content screens read the scope instead of the global default connection.
 */
const ConnectionScopeContext = createContext<string>('');

/** Wrap a subtree so its content hooks resolve to `connectionId` (used by the `(app)`
 * layout, which sources it from the content route's `?connection=` query param). */
export function ConnectionScope({
  connectionId,
  children,
}: {
  connectionId: string;
  children: ReactNode;
}) {
  return (
    <ConnectionScopeContext.Provider value={connectionId}>
      {children}
    </ConnectionScopeContext.Provider>
  );
}

/** The nearest route scope's connection id, or `''` outside any scope. */
export function useScopedCid(): string {
  return useContext(ConnectionScopeContext);
}

/**
 * The connection id to use for content: an explicit `connectionId` wins (a card passing
 * its own server), else the nearest route scope, else the default connection. One
 * definition so the resolution order can't drift across call sites.
 */
export function useCid(connectionId?: string): string {
  const scope = useScopedCid();
  const fallback = useDefaultCid();
  return connectionId ?? (scope || fallback);
}

/** The ApiClient for a connection (explicit id → route scope → default). Throws if none. */
export function useApi(connectionId?: string): ApiClient {
  const { clients } = useContext(ApiContext);
  const cid = useCid(connectionId);
  const client = clients.get(cid) ?? null;
  if (!client) {
    throw new Error('useApi() requires a configured server connection');
  }
  return client;
}

/** Like useApi but returns null instead of throwing (explicit id → route scope → default). */
export function useOptionalApi(connectionId?: string): ApiClient | null {
  const { clients } = useContext(ApiContext);
  const cid = useCid(connectionId);
  return clients.get(cid) ?? null;
}

/** Every connection of the person listening (the active profile's, Phase 8) paired with
 * its client, in user-defined order: what every aggregated screen shows (Home, Search,
 * the Library picker, You, the Journal). Background work never comes through here; it
 * resolves its own connection (`resolveClient`). The same array while the connections,
 * the clients and the profile's connections are (callers memoise on it: the Journal's
 * per-server queries and their merge). */
export function useApis(): ApiConnection[] {
  const { clients, connections } = useContext(ApiContext);
  // None while someone must be chosen (`mustChoose`): nothing of anyone shows.
  const ids = useProfiles(visibleConnectionIds);
  return useMemo(
    () =>
      connectionsOfProfile(connections, ids)
        .map((connection) => {
          const client = clients.get(connection.id);
          return client ? { connection, client } : null;
        })
        .filter((x): x is ApiConnection => x !== null),
    [clients, connections, ids],
  );
}
