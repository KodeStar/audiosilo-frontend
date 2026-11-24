import { useInfiniteQuery } from '@tanstack/react-query';

import { useAllBookPages } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { wholeLibraryQuery } from '@/api/startup-reads';

/** Read the library in server order, 200 books a page. The grid's sorting and
 * filtering happen on the device, so every view shares the same book list. */
export function useWholeLibrary(connectionId: string, libraryId: number) {
  const api = useOptionalApi(connectionId);
  return useAllBookPages(useInfiniteQuery(wholeLibraryQuery(connectionId, api, libraryId)));
}
