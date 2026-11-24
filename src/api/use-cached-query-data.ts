import {
  hashKey,
  notifyManager,
  type QueryClient,
  type QueryKey,
  type QueryState,
} from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

import { queryClient } from './provider';

const noSubscribe = () => () => {};

/**
 * What `pick` reads from a query's state as the cache holds it, never asked from here (no
 * fetch, no observer): one listener on the cache, for this entry, renders the caller again
 * when it changes (batched as React Query's own hooks are, so a write made while another
 * component renders never updates this one mid-render). No key (`false`, `null`,
 * `undefined`) or no entry: `pick` reads `undefined`, and with no key nothing listens.
 * `pick` answers a value or a reference the cache keeps, so an unchanged entry reads the
 * same. `client` is the app's own unless the caller has another (its context's).
 */
export function useCachedQueryState<R>(
  queryKey: QueryKey | false | null | undefined,
  pick: (state: QueryState | undefined) => R,
  client: QueryClient = queryClient,
): R {
  const hash = queryKey ? hashKey(queryKey) : undefined;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const notify = notifyManager.batchCalls(onChange);
      return client.getQueryCache().subscribe((e) => {
        if (e.query.queryHash === hash) notify();
      });
    },
    [client, hash],
  );
  // By the hash the listener follows (what `getQueryData` looks up, without hashing again).
  const read = () => pick(hash === undefined ? undefined : client.getQueryCache().get(hash)?.state);
  return useSyncExternalStore(hash ? subscribe : noSubscribe, read, read);
}

/** A query's data as the cache holds it ({@link useCachedQueryState}). Use it instead of
 * `getQueryData` at render (CONVENTIONS.md, "Cache reads at render"). */
export function useCachedQueryData<T>(
  queryKey: QueryKey | false | null | undefined,
): T | undefined {
  return useCachedQueryState(queryKey, (state) => state?.data as T | undefined);
}
