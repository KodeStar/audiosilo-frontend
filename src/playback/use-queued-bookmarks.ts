import { useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  loadQueuedBookmarks,
  onQueuedBookmarksChange,
  type QueuedBookmark,
  queuedBookmarksSnapshot,
} from './annotation-outbox';

const NONE: readonly QueuedBookmark[] = [];

/** One book's bookmarks still waiting on this device for its server (`annotation-outbox.ts`),
 * oldest first, kept current as the outbox changes (another tab's changes too). None for no
 * connection. */
export function useQueuedBookmarks(
  connectionId: string | undefined,
  libraryId: number,
  path: string,
): readonly QueuedBookmark[] {
  const all = useSyncExternalStore(onQueuedBookmarksChange, queuedBookmarksSnapshot);
  useEffect(() => {
    void loadQueuedBookmarks();
  }, []);
  return useMemo(() => {
    if (!connectionId) return NONE;
    const mine = all.filter(
      (e) => e.connectionId === connectionId && e.libraryId === libraryId && e.path === path,
    );
    return mine.length > 0 ? mine : NONE;
  }, [all, connectionId, libraryId, path]);
}
