import { hashKey, type QueryKey } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

import { queryClient } from './provider';

const noSubscribe = () => () => {};

/**
 * A query's data as the cache holds it, never asked from here (no fetch, no observer):
 * one listener on the cache for this entry renders the caller again when it changes. No
 * key (`false`, `null`, `undefined`): nothing listens and it reads `undefined`. Use it
 * instead of `getQueryData` at render (CONVENTIONS.md, "Cache reads at render").
 */
export function useCachedQueryData<T>(
  queryKey: QueryKey | false | null | undefined,
): T | undefined {
  const hash = queryKey ? hashKey(queryKey) : undefined;
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe((e) => {
        if (e.query.queryHash === hash) onChange();
      }),
    [hash],
  );
  const read = () => (queryKey ? queryClient.getQueryData<T>(queryKey) : undefined);
  return useSyncExternalStore(hash ? subscribe : noSubscribe, read, read);
}
