import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';

import { connectionIdFromKey, isServerInfoKey, serverResetCid } from '@/lib/auth-failure';
import { flushConnection } from '@/playback/progress-sync';
import { onConnectionRemoved, useSession, type Connection } from '@/stores/session';

import { pickedUrl, useAddressRoute } from './address-route';
import { ApiClient } from './client';
import { onReconnect, setReachabilityClients } from './reachability';

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
  if (isServerInfoKey(key)) {
    // Public /server success proves nothing about the token - never clears the flag;
    // it only DETECTS a server reset (a differing server_id ⇒ re-pair required).
    const cid = serverResetCid(key, data);
    if (cid) useSession.getState().markNeedsReconnect(cid, 'server-reset');
    return;
  }
  // Hot path: fires on EVERY successful fetch, so bail before allocating when nothing
  // is flagged (the overwhelmingly common case) - clearNeedsReconnect would just no-op.
  const { connections, clearNeedsReconnect } = useSession.getState();
  if (!connections.some((c) => c.needsReconnect)) return;
  const cid = connectionIdFromKey(
    key,
    connections.map((c) => c.id),
  );
  if (cid) clearNeedsReconnect(cid);
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // No onError: dead-token flagging lives on the ApiClient callback now (one choke
    // point for every request path). The cache keeps only success handling: clearing a
    // flag and detecting a server reset.
    onSuccess: (data, query) => noteQuerySuccess(data, query.queryKey),
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

// Evict the removed server's cached data (every query key leads with its connection
// id). Matching by `includes(id)` could in theory also match a same-string path
// segment, but that would only evict one extra entry - harmless, it just refetches.
onConnectionRemoved((id) => {
  queryClient.removeQueries({ predicate: (q) => q.queryKey.includes(id) });
});

// When a connection becomes reachable again, refetch that connection's queries (so
// screens that errored or emptied while it was offline repopulate on their own) and
// replay its queued progress saves. invalidateQueries only refetches currently-observed
// queries, so this is cheap; every query key leads with its connection id, so the
// predicate scopes the refetch to the recovered server.
onReconnect((connectionId) => {
  void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes(connectionId) });
  void flushConnection(connectionId);
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
            client: new ApiClient(url, c.token, undefined, () =>
              useSession.getState().markNeedsReconnect(c.id, 'auth'),
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

/** Every connection paired with its client, in user-defined order. The same array while
 * the connections and clients are (callers memoise on it: the Journal's per-server
 * queries and their merge). */
export function useApis(): ApiConnection[] {
  const { clients, connections } = useContext(ApiContext);
  return useMemo(
    () =>
      connections
        .map((connection) => {
          const client = clients.get(connection.id);
          return client ? { connection, client } : null;
        })
        .filter((x): x is ApiConnection => x !== null),
    [clients, connections],
  );
}
