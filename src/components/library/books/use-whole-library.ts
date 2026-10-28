import type { ApiClient } from '@/api/client';
import { libraryBooksQuery, useAllLibraryBooks } from '@/api/hooks';

/** The largest page GET /libraries/{id}/books gives (1-200). */
const PAGE_SIZE = 200;
/** The pages arrive newest first, the default view's order, so it fills in place; any
 * other order is sorted on the device either way. */
const SERVER_ORDER = { sort: 'recent' } as const;
/** A revisit within this long shows the list it has rather than reading every page
 * again (a scan adds books rarely; an empty library offers a refresh). */
const STALE_MS = 10 * 60_000;

/**
 * A library's WHOLE book list, for filtering and sorting on the device
 * (`useAllLibraryBooks`, 200 books a page). One cache entry per library, whatever the
 * screen's sort, since the sorting happens on the device.
 */
export function useWholeLibrary(connectionId: string, libraryId: number) {
  return useAllLibraryBooks(libraryId, SERVER_ORDER, connectionId, {
    pageSize: PAGE_SIZE,
    staleTime: STALE_MS,
  });
}

/** `useWholeLibrary`'s cache entry, for asking its first page before the Library grid
 * mounts (`components/shell/startup-queries.ts`): the same key, page size and freshness. */
export function wholeLibraryQuery(cid: string, client: ApiClient | null, libraryId: number) {
  return {
    ...libraryBooksQuery(cid, client, libraryId, SERVER_ORDER, PAGE_SIZE),
    staleTime: STALE_MS,
  };
}
