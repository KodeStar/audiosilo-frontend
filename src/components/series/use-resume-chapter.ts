import { useMemo } from 'react';

import { useChapters } from '@/api/hooks';
import { chapterNumberAt } from '@/components/library/meta-gating';
import { contentKey } from '@/lib/content-key';
import { chapterBookOffset } from '@/playback/book-queue';
import { selectBookKey, selectBookPosition, usePlayer } from '@/playback/store';
import type { PlayTarget } from '@/components/player/use-play-book';

/**
 * The chapter number a "Resume chapter N" button names for a book: its saved (or, when
 * it is loaded, live) whole-book position walked through its chapter starts. Undefined
 * until the chapters load, and for a book without chapters ("Resume" then).
 */
export function useResumeChapter(
  target: PlayTarget | undefined,
  savedPosition: number | undefined,
): number | undefined {
  const { data } = useChapters(target?.libraryId ?? 0, target?.path ?? '', target?.connectionId);
  const key = target ? contentKey(target.connectionId, target.libraryId, target.path) : null;
  // Coarse (per minute) so a playing book re-renders this rarely.
  const live = usePlayer((s) =>
    key && selectBookKey(s) === key ? Math.floor(selectBookPosition(s) / 60) * 60 : undefined,
  );
  const starts = useMemo(() => {
    const chapters = data?.chapters ?? [];
    const files = data?.files ?? [];
    if (files.length === 0) return chapters.map((c) => c.book_offset);
    const durations = files.map((f) => ({ path: f.rel_path, duration: f.duration }));
    return chapters.map((c) => chapterBookOffset(durations, c));
  }, [data]);
  if (!target || starts.length < 2) return undefined;
  const n = chapterNumberAt(starts, live ?? savedPosition ?? 0);
  return n > 0 ? n : undefined;
}
