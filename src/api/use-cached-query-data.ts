import { hashKey, notifyManager, type QueryKey } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

import { queryClient } from './provider';

const noSubscribe = () => () => {};

/**
 * A query's data as the cache holds it, never asked from here (no fetch, no observer):
 * one listener on the cache, for this entry, renders the caller again when it changes
 * (batched as React Query's own hooks are, so a write made while another component renders
 * never updates this one mid-render). No key (`false`, `null`, `undefined`): nothing listens
 * and it reads `undefined`. Use it instead of `getQueryData` at render (CONVENTIONS.md,
 * "Cache reads at render").
 */
export function useCachedQueryData<T>(
  queryKey: QueryKey | false | null | undefined,
): T | undefined {
  const hash = queryKey ? hashKey(queryKey) : undefined;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const notify = notifyManager.batchCalls(onChange);
      return queryClient.getQueryCache().subscribe((e) => {
        if (e.query.queryHash === hash) notify();
      });
    },
    [hash],
  );
  // By the hash the listener follows (what `getQueryData` looks up, without hashing again).
  const read = () =>
    hash === undefined ? undefined : (queryClient.getQueryCache().get(hash)?.state.data as T);
  return useSyncExternalStore(hash ? subscribe : noSubscribe, read, read);
}
