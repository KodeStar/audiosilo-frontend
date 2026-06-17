import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { useSession } from '@/stores/session';

import { ApiClient } from './client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ children }: { children: ReactNode }) {
  const serverUrl = useSession((s) => s.serverUrl);
  const token = useSession((s) => s.token);

  const client = useMemo(
    () => (serverUrl ? new ApiClient(serverUrl, token) : null),
    [serverUrl, token],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={client}>{children}</ApiContext.Provider>
    </QueryClientProvider>
  );
}

/** The configured client. Throws if no server URL has been set yet. */
export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) {
    throw new Error('useApi() requires a configured server URL');
  }
  return client;
}

/** Like useApi but returns null instead of throwing (for pre-connect screens). */
export function useOptionalApi(): ApiClient | null {
  return useContext(ApiContext);
}
