import { type SourcedProgress, useLibraryBooks, useMyStats } from '@/api/hooks';

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
  const { data: stats } = useMyStats('30d', cid ?? undefined);
  const top = stats?.top_narrators[0];
  const libraryId = inProgress.find((p) => p.connectionId === cid)?.library_id;
  const sample = useLibraryBooks(libraryId ?? 0, { narrator: top?.name ?? '' }, cid ?? undefined, {
    pageSize: SAMPLE,
    enabled: !!cid && !!top && libraryId !== undefined,
    staleTime: 10 * 60_000,
  }).data?.pages[0]?.books;
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
