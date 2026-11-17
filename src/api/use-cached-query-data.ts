import { hashKey, type QueryKey } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

import { queryClient } from './provider';

const noSubscribe = () => () => {};

/**
 * A query's data as the cache holds it, never asked from here (no fetch, no observer):
 * while `enabled`, one listener on the cache for this entry renders the caller again when
 * it changes; while not, nothing listens and it reads `undefined`.
 *
 * For a render that would read `queryClient.getQueryData`: the React Compiler memoises
 * that read against its inputs (the key's parts), so it is never read again while they
 * stay the same, whatever the cache does meanwhile (CONVENTIONS.md, "Cache reads at
 * render"). React reads this one at every render and on every change.
 */
export function useCachedQueryData<T>(queryKey: QueryKey, enabled = true): T | undefined {
  const hash = hashKey(queryKey);
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe((e) => {
        if (e.query.queryHash === hash) onChange();
      }),
    [hash],
  );
  const read = () => (enabled ? queryClient.getQueryData<T>(queryKey) : undefined);
  return useSyncExternalStore(enabled ? subscribe : noSubscribe, read, read);
}
