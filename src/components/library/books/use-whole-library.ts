import { skipToken, useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { qk } from '@/api/hooks';
import { useCid, useOptionalApi } from '@/api/provider';
import type { Book, BookSort } from '@/api/types';

/** The largest page GET /libraries/{id}/books gives (1-200). */
const PAGE_SIZE = 200;

/**
 * A library's WHOLE book list, for filtering and sorting on the device: page after page
 * of `listBooks` (200 each, in the server's `sort`) until `next_cursor` runs out. The
 * pages so far are usable at once (`complete` false while more are coming). A failed
 * page stops the run and keeps what loaded; `retry` carries on from there (or starts
 * over when the first page failed). Its own key under the `libraryBooks` prefix, so it
 * never mixes its 200-book pages with `useLibraryBooks`' 100-book ones.
 */
export function useWholeLibrary(connectionId: string, libraryId: number, sort: BookSort) {
  const api = useOptionalApi(connectionId);
  const cid = useCid(connectionId);
  const query = useInfiniteQuery({
    queryKey: [...qk.libraryBooks(cid, libraryId, { sort }), 'whole'],
    queryFn: api
      ? ({ pageParam, signal }) =>
          api.listBooks(libraryId, { sort, limit: PAGE_SIZE, cursor: pageParam }, signal)
      : skipToken,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage, data } = query;

  // Keyed on the page count too: a page can arrive within one render of the request
  // that asked for it, leaving the flags as they were and the effect asleep.
  const pages = data?.pages.length ?? 0;
  useEffect(() => {
    if (hasNextPage && !isFetching && !isFetchNextPageError) void fetchNextPage();
  }, [pages, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);

  const books = useMemo<Book[]>(() => data?.pages.flatMap((p) => p.books) ?? [], [data]);
  return {
    books,
    /** Every page is in. */
    complete: !!data && !hasNextPage,
    /** Nothing loaded yet. */
    isLoading: query.isLoading,
    error: query.error,
    retry: () => void (data ? fetchNextPage() : query.refetch()),
    /** Read the whole list again (an empty library: the server may have scanned since). */
    refresh: () => void query.refetch(),
  };
}
