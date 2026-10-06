import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import type { BookListQuery } from '@/api/client';
import { qk, useAllProgressAll, useLibraryBooks } from '@/api/hooks';
import { useApis } from '@/api/provider';
import type { Book, BookRef } from '@/api/types';
import { contentKey } from '@/lib/content-key';

import type { ElsewhereBook, ProgressLookup } from './series-model';

/**
 * The data the series, author and narrator pages read, as small feature-local hooks over
 * the shared `src/api` ones (no new wire calls).
 */

/**
 * Every book of a filtered library list (`useLibraryBooks`: an exact `series`,
 * `author` or `narrator`), fetching the remaining pages on its own: a series or a
 * person is a handful of books, so the page wants them all before it orders them.
 * `complete` once the last page is in.
 */
export function useAllLibraryBooks(libraryId: number, query: BookListQuery, connectionId?: string) {
  const q = useLibraryBooks(libraryId, query, connectionId);
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = q;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  const books = useMemo(() => q.data?.pages.flatMap((p) => p.books) ?? [], [q.data]);
  return {
    books,
    /** Nothing loaded yet (the first page). */
    isLoading: q.isPending && q.fetchStatus !== 'idle',
    /** The query can't run (no client, or a narrator filter on a server without it). */
    isIdle: q.isPending && q.fetchStatus === 'idle',
    complete: !!q.data && !hasNextPage,
    error: q.error,
    refetch: q.refetch,
  };
}

/**
 * The listener's saved progress on every connection, as a lookup by
 * (connection, library, path): what marks a spine finished, the book you're on and a
 * tile's progress bar. One fetch per connection, shared with Home and the palette.
 */
export function useProgressLookup(): { progressOf: ProgressLookup; isLoading: boolean } {
  const { progress, isLoading } = useAllProgressAll();
  const progressOf = useMemo<ProgressLookup>(() => {
    const byKey = new Map(
      progress.map((p) => [contentKey(p.connectionId, p.library_id, p.path), p]),
    );
    return (c, l, p) => byKey.get(contentKey(c, l, p));
  }, [progress]);
  return { progressOf, isLoading };
}

/**
 * The books of a series on the listener's OTHER connections, for "On Maya's Shelf":
 * ONE search per other server for the series name (the server's search covers the
 * series field), rather than one per missing title. A copy filed under a differently
 * named series there, and not titled like the series either, is not found: the entry
 * then stays a ghost. Shares the Search screen's cache entries.
 */
export function useElsewhereBooks(connectionId: string, seriesName: string | undefined) {
  const apis = useApis().filter((a) => a.connection.id !== connectionId);
  const q = (seriesName ?? '').trim();
  return useQueries({
    queries: apis.map(({ connection, client }) => ({
      queryKey: qk.search(connection.id, q),
      queryFn: ({ signal }: { signal: AbortSignal }) => client.search(q, 50, signal),
      enabled: q.length > 0,
      staleTime: 5 * 60_000,
    })),
    combine: (results) =>
      results.flatMap((r, i) =>
        (r.data ?? []).map((b): ElsewhereBook => ({
          ...b,
          connectionId: apis[i].connection.id,
          connectionName: apis[i].connection.name,
        })),
      ),
  });
}

/**
 * The list rows of books a rail places in OTHER libraries than the page's (a community
 * series can span them): `/item` for each, keyed like `useBook` so the book page reuses
 * the answer. Only what isn't already loaded is asked for.
 */
export function usePlacedBooks(connectionId: string, refs: readonly BookRef[]): Book[] {
  const apis = useApis();
  const client = apis.find((a) => a.connection.id === connectionId)?.client;
  return useQueries({
    queries: refs.map((r) => ({
      queryKey: qk.item(connectionId, r.library_id, r.path),
      queryFn: ({ signal }: { signal: AbortSignal }) => client!.item(r.library_id, r.path, signal),
      enabled: !!client,
      staleTime: 5 * 60_000,
    })),
    combine: (results) => results.flatMap((r) => (r.data ? [r.data] : [])),
  });
}
