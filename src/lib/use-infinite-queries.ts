import {
  type DefaultError,
  type InfiniteData,
  InfiniteQueryObserver,
  type InfiniteQueryObserverOptions,
  type InfiniteQueryObserverResult,
  notifyManager,
  type QueryClient,
  type QueryKey,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Many infinite queries at once, one per entry of a list that can grow and shrink (a list
 * per signed-in server): TanStack has `useQueries` for plain queries but nothing for
 * infinite ones. Each entry gets its own `InfiniteQueryObserver`, kept by query hash
 * across renders (so a query keeps its observer while the list around it changes), and
 * the results are read through `useSyncExternalStore`. Gate an entry the way
 * `useQueries` users do: `skipToken` as its `queryFn` (nothing asks, not even a
 * `refetch`) or `enabled: false` (the cache is read, nothing is fetched).
 *
 * Unlike `useInfiniteQuery`, results are not tracked per property (a change to any field
 * re-renders) and there is no suspense or `throwOnError`.
 */

export type InfiniteQueriesOptions<TPage, TPageParam> = InfiniteQueryObserverOptions<
  TPage,
  DefaultError,
  InfiniteData<TPage, TPageParam>,
  QueryKey,
  TPageParam
>;

export type InfiniteQueriesResult<TPage, TPageParam> = InfiniteQueryObserverResult<
  InfiniteData<TPage, TPageParam>,
  DefaultError
>;

type Observer<TPage, TPageParam> = InfiniteQueryObserver<
  TPage,
  DefaultError,
  InfiniteData<TPage, TPageParam>,
  QueryKey,
  TPageParam
>;

/** The observers of one hook, by query hash, their subscriptions and the last results it
 * handed out. */
class ObserverPool<TPage, TPageParam> {
  #client: QueryClient;
  #byHash = new Map<string, Observer<TPage, TPageParam>>();
  #observers: Observer<TPage, TPageParam>[] = [];
  #results: InfiniteQueriesResult<TPage, TPageParam>[] = [];
  #listeners = new Set<() => void>();
  #subscriptions = new Map<Observer<TPage, TPageParam>, () => void>();
  #notify = notifyManager.batchCalls(() => this.#listeners.forEach((l) => l()));

  constructor(client: QueryClient) {
    this.#client = client;
  }

  /** One observer per entry of `list`, the same array while the queries are the same. A
   * new observer starts with its entry's options; an existing one gets them after the
   * commit (`setOptions`, as `useInfiniteQuery` does). */
  observersFor(
    list: readonly InfiniteQueriesOptions<TPage, TPageParam>[],
  ): Observer<TPage, TPageParam>[] {
    const byHash = new Map<string, Observer<TPage, TPageParam>>();
    const next = list.map((options) => {
      const hash = this.#client.defaultQueryOptions(options).queryHash;
      const observer = this.#byHash.get(hash) ?? new InfiniteQueryObserver(this.#client, options);
      byHash.set(hash, observer);
      return observer;
    });
    this.#byHash = byHash;
    if (!sameItems(next, this.#observers)) this.#observers = next;
    return this.#observers;
  }

  /** Subscribe the observers not subscribed yet and drop the ones no longer listed: a
   * query that stays in the list stays subscribed (no refetch on a second mount). */
  track(observers: readonly Observer<TPage, TPageParam>[]) {
    const keep = new Set(observers);
    for (const [o, unsubscribe] of this.#subscriptions) {
      if (keep.has(o)) continue;
      unsubscribe();
      this.#subscriptions.delete(o);
    }
    for (const o of observers) {
      if (!this.#subscriptions.has(o)) this.#subscriptions.set(o, o.subscribe(this.#notify));
    }
  }

  /** For `useSyncExternalStore`: told whenever any observer's result changes. */
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The observers' current results, the same array while every result is. */
  resultsOf(observers: readonly Observer<TPage, TPageParam>[]) {
    const next = observers.map((o) => o.getCurrentResult());
    if (!sameItems(next, this.#results)) this.#results = next;
    return this.#results;
  }
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function useInfiniteQueries<TPage, TPageParam>(
  list: readonly InfiniteQueriesOptions<TPage, TPageParam>[],
): readonly InfiniteQueriesResult<TPage, TPageParam>[] {
  const client = useQueryClient();
  const [pool] = useState(() => new ObserverPool<TPage, TPageParam>(client));
  const observers = pool.observersFor(list);

  // The options first, so a newly subscribed observer fetches by this render's.
  useEffect(() => {
    observers.forEach((o, i) => o.setOptions(list[i]));
    pool.track(observers);
  }, [pool, observers, list]);
  useEffect(() => () => pool.track([]), [pool]);

  const snapshot = () => pool.resultsOf(observers);
  return useSyncExternalStore(pool.subscribe, snapshot, snapshot);
}
