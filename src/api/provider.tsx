import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';

import { useSession, type Connection } from '@/stores/session';

import { ApiClient } from './client';
import { setReachabilityApi } from './reachability';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

type ApiRegistry = {
  clients: Map<string, ApiClient>;
  connections: Connection[];
  activeId: string | null;
};

const ApiContext = createContext<ApiRegistry>({
  clients: new Map(),
  connections: [],
  activeId: null,
});

/** A connection paired with its API client. */
export type ApiConnection = { connection: Connection; client: ApiClient };

export function ApiProvider({ children }: { children: ReactNode }) {
  const connections = useSession((s) => s.connections);
  const activeId = useSession((s) => s.activeConnectionId);

  const registry = useMemo<ApiRegistry>(() => {
    const clients = new Map<string, ApiClient>();
    for (const c of connections) clients.set(c.id, new ApiClient(c.serverUrl, c.token));
    return { clients, connections, activeId };
  }, [connections, activeId]);

  // Keep the reachability probe pointed at the active connection's client.
  useEffect(() => {
    setReachabilityApi(registry.clients.get(registry.activeId ?? '') ?? null);
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

/** The ApiClient for a connection (defaults to the active one). Throws if none. */
export function useApi(connectionId?: string): ApiClient {
  const { clients, activeId } = useContext(ApiContext);
  const client = clients.get(connectionId ?? activeId ?? '') ?? null;
  if (!client) {
    throw new Error('useApi() requires a configured server connection');
  }
  return client;
}

/** Like useApi but returns null instead of throwing (defaults to active). */
export function useOptionalApi(connectionId?: string): ApiClient | null {
  const { clients, activeId } = useContext(ApiContext);
  return clients.get(connectionId ?? activeId ?? '') ?? null;
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
