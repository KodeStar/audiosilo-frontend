import { useMemo } from 'react';

import { useChapters } from '@/api/hooks';
import { useApis } from '@/api/provider';
import { chapterNumberAt } from '@/components/library/meta-gating';
import { contentKey } from '@/lib/content-key';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { chapterBookOffset } from '@/playback/book-queue';
import { selectBookKey, selectBookPosition, usePlayer } from '@/playback/store';

/** A book to start: on which connection, library and path. */
export type PlayTarget = { connectionId: string; libraryId: number; path: string };

/**
 * Start (or resume) a book from a browse page, the way Home's progress cards do: on a
 * phone, open the full player over the page (closing it returns here); on a tablet or
 * desktop play inline under the docked player bar, resuming from the saved place
 * (the store's resume lookup). A book already loaded just plays on.
 */
export function usePlayCopy() {
  const phone = useLayout() === 'phone';
  const apis = useApis();
  const { openPlayer } = useOpen();
  return async (target: PlayTarget) => {
    if (phone) {
      openPlayer(target.connectionId, target.libraryId, target.path);
      return;
    }
    const store = usePlayer.getState();
    if (selectBookKey(store) === contentKey(target.connectionId, target.libraryId, target.path)) {
      if (store.snapshot.state !== 'playing' && store.snapshot.state !== 'loading') {
        await store.toggle();
      }
      return;
    }
    const client = apis.find((a) => a.connection.id === target.connectionId)?.client;
    if (!client) return;
    const [book, chapterData] = await Promise.all([
      client.item(target.libraryId, target.path),
      client.chapters(target.libraryId, target.path),
    ]);
    await store.playBook(target.connectionId, target.libraryId, book, chapterData);
  };
}

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
