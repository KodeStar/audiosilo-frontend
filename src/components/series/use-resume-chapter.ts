import { useMemo } from 'react';

import { useChapters } from '@/api/hooks';
import { chapterNumberAt, chapterStartsOf } from '@/components/library/meta-gating';
import { useListeningPosition } from '@/components/player/use-listening-position';
import type { PlayTarget } from '@/components/player/use-play-book';

/**
 * The chapter number a "Resume chapter N" button names for a book: where the listener
 * is (`useListeningPosition`, read per minute so a playing book re-renders this rarely)
 * walked through its chapter starts. Undefined until the chapters load, and for a book
 * without chapters ("Resume" then).
 */
export function useResumeChapter(
  target: PlayTarget | undefined,
  savedPosition: number | undefined,
): number | undefined {
  const { data } = useChapters(target?.libraryId ?? 0, target?.path ?? '', target?.connectionId);
  const position = useListeningPosition(target, savedPosition, 60);
  const starts = useMemo(() => chapterStartsOf(data?.chapters ?? [], data?.files ?? []), [data]);
  if (!target || starts.length < 2) return undefined;
  const n = chapterNumberAt(starts, position ?? 0);
  return n > 0 ? n : undefined;
}
