import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { Bookmark } from '@/api/types';

import {
  heldOnServer,
  loadQueuedBookmarks,
  onQueuedBookmarksChange,
  type QueuedBookmark,
  queuedBookmarksSnapshot,
} from './annotation-outbox';

const NONE: readonly QueuedBookmark[] = [];

/** One book's bookmarks still waiting on this device for its server (`annotation-outbox.ts`),
 * oldest first, kept current as the outbox changes (another tab's changes too). None for no
 * connection. `listed`: the book's bookmarks as the server last listed them, when known; a
 * waiting one the server already holds (sent, not yet out of the outbox) is left out, so it
 * never shows twice. */
export function useQueuedBookmarks(
  connectionId: string | undefined,
  libraryId: number,
  path: string,
  listed?: readonly Bookmark[],
): readonly QueuedBookmark[] {
  // The same snapshot for the web's static render (an empty outbox until it is read).
  const all = useSyncExternalStore(
    onQueuedBookmarksChange,
    queuedBookmarksSnapshot,
    queuedBookmarksSnapshot,
  );
  useEffect(() => {
    void loadQueuedBookmarks();
  }, []);
  return useMemo(() => {
    if (!connectionId) return NONE;
    const mine = all.filter(
      (e) =>
        e.connectionId === connectionId &&
        e.libraryId === libraryId &&
        e.path === path &&
        !(listed && heldOnServer(e, listed)),
    );
    return mine.length > 0 ? mine : NONE;
  }, [all, connectionId, libraryId, path, listed]);
}
