import type { TFunction } from 'i18next';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useBookProgress, useChapters } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import type { BookFile, Chapter } from '@/api/types';
import { chapterStartsOf } from '@/components/library/meta-gating';
import { selectPlacedBookKey } from '@/components/player/use-listening-position';
import { chapterLabel } from '@/lib/chapter-label';
import { contentKeyOf } from '@/lib/content-key';
import { chapterAt } from '@/playback/book-queue';
import { selectBookPosition, usePlayer } from '@/playback/store';

import type { AnnotationTarget } from './editor-model';

/**
 * A namer of the chapter at a whole-book position (pure): the book's chapters on their
 * offsets recomputed from the file durations (the server's `book_offset` is unreliable
 * for some books; `chapterStartsOf`, as the book page does), each named as the player
 * names it ("Bridge Four", else "Chapter 23"). A book without chapters names nothing.
 */
export function chapterNamer(
  chapters: Chapter[] | undefined,
  files: Pick<BookFile, 'rel_path' | 'duration'>[] | undefined,
  t: TFunction,
): (position: number) => string | null {
  if (!chapters || chapters.length === 0) return () => null;
  const starts = chapterStartsOf(chapters, files ?? []);
  const placed = chapters.map((ch, i) => ({ ...ch, book_offset: starts[i] }));
  return (position) => {
    const ch = chapterAt(placed, position);
    return ch ? chapterLabel(ch, t) : null;
  };
}

/** `chapterNamer` for a book, from its chapters on its own connection (the cached
 * `useChapters` read the book page and the player already make). */
export function useChapterNamer(target: AnnotationTarget): (position: number) => string | null {
  const { t } = useTranslation();
  const api = useOptionalApi(target.connectionId);
  const { data } = useChapters(target.libraryId, target.path, target.connectionId, {
    enabled: !!api,
  });
  return useMemo(() => chapterNamer(data?.chapters, data?.files, t), [data, t]);
}

/**
 * Where something added now lands in `target`, in whole seconds: the live place while it
 * is the loaded book (once its engine has placed it, `selectPlacedBookKey`), else the
 * listener's saved place in it, else the start. Re-renders every second while the book
 * plays, so read it in a small leaf (a button's label).
 */
export function usePlaceIn(target: AnnotationTarget): number {
  const key = contentKeyOf(target);
  const live = usePlayer((s) =>
    selectPlacedBookKey(s) === key ? Math.floor(selectBookPosition(s)) : undefined,
  );
  const api = useOptionalApi(target.connectionId);
  const { data: progress } = useBookProgress(
    target.libraryId,
    target.path,
    live === undefined && !!api,
    target.connectionId,
  );
  return live ?? Math.floor(progress?.position ?? 0);
}
