import { useMemo } from 'react';

import { useChapters } from '@/api/hooks';
import { chapterNumberAt, chapterStartsOf } from '@/components/library/meta-gating';
import { useResumePosition } from '@/components/player/use-listening-position';
import type { PlayTarget } from '@/components/player/use-play-book';
import type { NamedChapter } from '@/lib/chapter-label';

/**
 * The chapter (its number and title) a "Resume chapter N" button names for a book: where a press plays
 * it from (`useResumePosition`, read per minute so a playing book re-renders this rarely)
 * walked through its chapter starts. Undefined until the chapters load, and for a book
 * without chapters ("Resume" then).
 */
export function useResumeChapter(
  target: PlayTarget | undefined,
  savedPosition: number | undefined,
): NamedChapter | undefined {
  const { data } = useChapters(target?.libraryId ?? 0, target?.path ?? '', target?.connectionId);
  const position = useResumePosition(target, savedPosition, 60);
  const starts = useMemo(() => chapterStartsOf(data?.chapters ?? [], data?.files ?? []), [data]);
  if (!target || starts.length < 2) return undefined;
  const n = chapterNumberAt(starts, position ?? 0);
  // `starts` is one per chapter, so the number indexes `data.chapters`.
  return n > 0 ? { number: n, title: data?.chapters[n - 1]?.title ?? '' } : undefined;
}
