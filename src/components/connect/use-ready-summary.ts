import { skipToken, useQueries, useQuery } from '@tanstack/react-query';

import { allProgressQuery, qk, useBook, useCapability, useChapters } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import type { Book } from '@/api/types';
import type { PlayTarget } from '@/components/player/play-route';
import { useResumePosition } from '@/components/player/use-listening-position';
import { useResumeChapter } from '@/components/series/use-resume-chapter';
import type { NamedChapter } from '@/lib/chapter-label';
import { percentHeard } from '@/lib/progress-view';

import { bookTotal, latestPlace, readyLine, type ReadyLine } from './connect-model';

/** How many of the newest books the shelf may stand up. */
const SHELF_BOOKS = 24;

/** Where the listener's place came from: the book (`book`, to play it), its title, its
 * chapter (when it has chapters) and how far in. */
export type ReadyPlace = {
  book: PlayTarget;
  title: string;
  chapter?: NamedChapter;
  percent: number;
};

export type ReadySummary = {
  /** The library sentence; null while it is loading. */
  line: ReadyLine | null;
  /** The libraries couldn't be read (the screen says so and stays usable). */
  failed: boolean;
  /** The newest books, for the shelf; undefined while loading (or unread: the plank stays bare). */
  books: readonly Book[] | undefined;
  /** "Your place in <book> came with you", when the listener has one. */
  place: ReadyPlace | null;
};

/**
 * What "Your library is ready." says about a server just connected (`connectionId`):
 * its libraries and book count (one authors list per library, capability
 * `browse_people`: every book counts once), its newest books for the shelf, and the book
 * the listener was last on there. Shares the app's query cache, so Home opens warm.
 */
export function useReadySummary(connectionId: string): ReadySummary {
  const api = useOptionalApi(connectionId);
  const libraries = useQuery({
    queryKey: qk.libraries(connectionId),
    queryFn: api ? () => api.libraries() : skipToken,
  });
  const browse = useCapability('browse_people', connectionId);
  const libs = libraries.data ?? [];
  const lists = useQueries({
    queries: libs.map((l) => ({
      queryKey: qk.authors(connectionId, l.id),
      queryFn:
        api && browse
          ? ({ signal }: { signal: AbortSignal }) => api.authors(l.id, signal)
          : skipToken,
    })),
  });
  const counted = bookTotal(lists.map((q) => q.data));
  // Counting: the flag isn't known yet, or a list is still on its way. Can't count: no
  // flag, or a list failed.
  const books =
    browse === undefined
      ? undefined
      : !browse || lists.some((q) => q.isError)
        ? null
        : (counted ?? undefined);

  const recent = useQuery({
    queryKey: qk.recent(connectionId, SHELF_BOOKS),
    queryFn: api ? ({ signal }) => api.recentBooks(SHELF_BOOKS, signal) : skipToken,
  });

  const progress = useQuery(allProgressQuery(connectionId, api));
  const at = latestPlace(progress.data);
  const target = at ? { connectionId, libraryId: at.library_id, path: at.path } : undefined;
  const { data: book } = useBook(at?.library_id ?? 0, at?.path ?? '', connectionId, {
    enabled: !!at,
  });
  const { data: chapters } = useChapters(at?.library_id ?? 0, at?.path ?? '', connectionId, {
    enabled: !!at,
  });
  // The chapter and the percent from ONE place: the player's when this book is loaded
  // (a press plays it from there), else the saved one.
  const chapter = useResumeChapter(target, at?.position);
  const position = useResumePosition(target, at?.position, 60) ?? 0;
  const total = chapters?.duration || at?.duration || book?.duration || 0;
  const place: ReadyPlace | null =
    target && book
      ? {
          book: target,
          title: book.title,
          chapter,
          percent: percentHeard(position, total, false),
        }
      : null;

  return {
    line: readyLine({
      libraries: libraries.data?.map((l) => l.name),
      books,
    }),
    failed: libraries.isError,
    books: recent.data,
    place,
  };
}
