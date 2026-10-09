import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';

import { itemQuery, searchQuery, tagBooks, useAllLibraryBooks } from '@/api/hooks';
import { useApis, useOptionalApi } from '@/api/provider';
import type { Book, BookRef } from '@/api/types';

import { inSeries, type ElsewhereBook } from './series-model';

/**
 * The data the series page reads beyond the shared `src/api` hooks (no new wire
 * calls).
 */

/**
 * Every book of a series in a library (`useAllLibraryBooks` by `series`), each as it
 * stands in that series (`inSeries`): a book in several is numbered by this one.
 * `batch` (a series card) fetches the first page in one request with the other cards on
 * screen (`LibraryBooksOptions.batch`); the cache entry is the same either way.
 */
export function useSeriesBooks(
  libraryId: number,
  name: string,
  connectionId?: string,
  { batch }: { batch?: boolean } = {},
) {
  const list = useAllLibraryBooks(libraryId, { series: name }, connectionId, { batch });
  const books = useMemo(() => list.books.map((b) => inSeries(b, name) ?? b), [list.books, name]);
  return { ...list, books };
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
      ...searchQuery(connection.id, client, q),
      staleTime: 5 * 60_000,
    })),
    combine: (results): ElsewhereBook[] => tagBooks(results, apis),
  });
}

/**
 * The list rows of books a rail places in OTHER libraries than the page's (a community
 * series can span them): `/item` for each, keyed like `useBook` so the book page reuses
 * the answer. Only what isn't already loaded is asked for.
 */
export function usePlacedBooks(connectionId: string, refs: readonly BookRef[]): Book[] {
  const client = useOptionalApi(connectionId);
  return useQueries({
    queries: refs.map((r) => ({
      ...itemQuery(connectionId, client, r.library_id, r.path),
      staleTime: 5 * 60_000,
    })),
    combine: (results) => results.flatMap((r) => (r.data ? [r.data] : [])),
  });
}
