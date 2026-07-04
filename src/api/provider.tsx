import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';

import { flushConnection } from '@/playback/progress-sync';
import { onConnectionRemoved, useSession, type Connection } from '@/stores/session';

import { ApiClient } from './client';
import { onReconnect, setReachabilityClients } from './reachability';

export const queryClient = new QueryClient({
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

export function ApiProvider({ children }: { children: ReactNode }) {
  const connections = useSession((s) => s.connections);

  // Build the clients only when the connections change - re-rendering for an
  // unrelated reason must not tear down and recreate every ApiClient (it would drop
  // in-flight reachability probes and force-refetch every query).
  const clients = useMemo<Map<string, ApiClient>>(() => {
    const map = new Map<string, ApiClient>();
    for (const c of connections) map.set(c.id, new ApiClient(c.serverUrl, c.token));
    return map;
  }, [connections]);

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
 * scoped to a specific server (the sidebar, the connect flow default). Internal to the
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

/** Every connection paired with its client, in user-defined order. */
export function useApis(): ApiConnection[] {
  const { clients, connections } = useContext(ApiContext);
  return connections
    .map((connection) => {
      const client = clients.get(connection.id);
      return client ? { connection, client } : null;
    })
    .filter((x): x is ApiConnection => x !== null);
}
