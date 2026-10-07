import { QueryClient } from '@tanstack/react-query';

/**
 * The shared stand-in for `@/api/provider`: fake clients by connection id behind the
 * provider's lookups (`useApis`, `useApiRegistry`, `useOptionalApi`, `useCid`) and its
 * module-level `queryClient`, so a hook that resolves a client either way finds the same
 * one. The first connection is the default.
 *
 * ```ts
 * jest.mock('@/api/provider', () =>
 *   // `require` because a jest.mock factory is hoisted above every import.
 *   require('@/testing/api-provider-mock').apiProviderMock({
 *     c: { item: (...a: unknown[]) => mockItem(...a) },
 *   }),
 * );
 * ```
 */
export function apiProviderMock(clients: Record<string, object>) {
  const map = new Map(Object.entries(clients));
  const ids = [...map.keys()];
  const connections = ids.map((id) => ({ id, name: id }));
  return {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }),
    useApis: () =>
      connections.map((connection) => ({ connection, client: map.get(connection.id) })),
    useApiRegistry: () => ({ clients: map, connections }),
    useOptionalApi: (id?: string) => map.get(id ?? ids[0]) ?? null,
    useApi: (id?: string) => map.get(id ?? ids[0]),
    useCid: (id?: string) => id ?? ids[0] ?? '',
  };
}
