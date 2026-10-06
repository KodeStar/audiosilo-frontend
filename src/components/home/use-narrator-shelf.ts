import { skipToken, useQuery } from '@tanstack/react-query';

import { type SourcedProgress, useCapability, useMyStats } from '@/api/hooks';
import { useApis } from '@/api/provider';
import type { Book } from '@/api/types';

/** Covers a smart shelf fans. */
const SAMPLE = 3;

/**
 * The "<Narrator> reads" smart shelf's source: the listener's most-heard narrator over
 * the last 30 days (`user_stats`, the default server) and a few of their books from the
 * library the listener last played on that server (`/books?narrator=`, which needs
 * `browse_people`). Undefined until all of that is known, or when any part is missing:
 * a narrator with no books in that library makes no shelf.
 */
export function useNarratorShelf(cid: string | null, inProgress: readonly SourcedProgress[]) {
  const apis = useApis();
  const client = apis.find((a) => a.connection.id === cid)?.client ?? null;
  const { data: stats } = useMyStats('30d', cid ?? undefined);
  const browse = useCapability('browse_people', cid ?? undefined) === true;
  const top = stats?.top_narrators[0];
  const libraryId = inProgress.find((p) => p.connectionId === cid)?.library_id;
  const { data: sample } = useQuery({
    queryKey: ['homeNarratorShelf', cid, libraryId, top?.name],
    queryFn:
      client && browse && top && libraryId !== undefined
        ? ({ signal }) =>
            client
              .listBooks(libraryId, { narrator: top.name, limit: SAMPLE }, signal)
              .then((p): Book[] => p.books)
        : skipToken,
    staleTime: 10 * 60_000,
  });
  if (!cid || !top || libraryId === undefined || !sample) return undefined;
  return {
    name: top.name,
    books: top.books,
    listened: top.listened,
    connectionId: cid,
    libraryId,
    sample,
  };
}
