import { router, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { resolveClient } from '@/api/connection-clients';
import { finishedHref, playerHref } from '@/lib/paths';
import { selectIsEnded, usePlayer, type FinishedBook } from '@/playback/store';
import { resolveUpNext } from '@/playback/up-next-resolver';
import { upNextSources } from '@/playback/up-next-sources';
import { useSettings } from '@/stores/settings';

import { useQueueDrop } from './use-queue-drop';

/**
 * Headless, mounted once at the root so it covers every layout (phone modal + wide
 * desktop). It watches the player store for the transition into `ended` (the book
 * reached its natural end - the store keeps nowPlaying populated in that state) and
 * drives the end-of-book flow. Transition-EDGE detection (a ref, not the level) so it
 * fires once per ended book, and only for a real book (nowPlaying set).
 */
export function BookEndedListener() {
  const isEnded = usePlayer(selectIsEnded);
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const pathname = usePathname();
  const wasEnded = useRef(false);

  // The queue writes after a book ends belong to ITS connection, which must outlive
  // nowPlaying (finishBook clears it before the next book is resolved): the last loaded
  // book's connection, kept until another book loads.
  const loadedCid = nowPlaying?.connectionId;
  const [queueCid, setQueueCid] = useState(loadedCid);
  if (loadedCid && loadedCid !== queueCid) setQueueCid(loadedCid);
  const dropFromQueue = useQueueDrop(loadedCid ?? queueCid);

  useEffect(() => {
    const prev = wasEnded.current;
    wasEnded.current = isEnded;
    // Only on the false→true edge, and only with a real book loaded.
    if (!isEnded || prev || !nowPlaying) return;
    // Capture the finished book's identity and tear playback down (persists finished,
    // clears nowPlaying, optionally deletes the local copy). Done even when the credits
    // screen is already open, so a natural end ALWAYS finalizes the book - otherwise
    // (with auto-play off, the default, or no next book) nowPlaying would stay stuck in
    // `ended` and the mini-player would remain docked showing the just-finished book.
    const info = usePlayer.getState().finishBook();
    if (!info) return;
    handleBookEnded(info, pathname, dropFromQueue);
  }, [isEnded, nowPlaying, pathname, dropFromQueue]);

  return null;
}

/** Decide what to do once the current book has ended, given the route we're on. */
function handleBookEnded(
  info: FinishedBook,
  pathname: string,
  dropFromQueue: ReturnType<typeof useQueueDrop>,
): void {
  // A finished book is no longer "up next". The credits opened by the end (`auto=1`)
  // take it off the queue themselves (so does "Mark as finished", which opens them the
  // same way); the two paths that don't open them do it here.
  const finished = { library_id: info.libraryId, path: info.path };

  // Already showing the end-credits screen: it drives its own countdown + Play now from
  // here, so don't navigate again (that would stack a duplicate /finished).
  if (pathname === '/finished') {
    void dropFromQueue([finished]);
    return;
  }

  // Locked / backgrounded with auto-play on: iOS may suspend JS soon after audio stops,
  // so don't gamble on a visible countdown - resolve the next book (the same answer the
  // credits screen would give: Up next first, then the series) and jump straight to the
  // player. Fall back to the normal end-credits navigation if there's no next book.
  if (AppState.currentState !== 'active' && useSettings.getState().autoPlayNext) {
    void (async () => {
      const client = resolveClient(info.connectionId);
      const { next } = client
        ? await resolveUpNext(upNextSources(client, info.connectionId), info)
        : { next: null };
      if (next) {
        // Replace only when we're already on the player; otherwise push, so we don't drop
        // whatever route the user was on (library/downloads/...) from the back stack.
        const href = playerHref(next.connectionId, next.libraryId, next.path);
        if (pathname === '/player') router.replace(href);
        else router.push(href);
        // It is the book you're on now, no longer up next.
        void dropFromQueue(next.queueEntry ? [finished, next.queueEntry] : [finished]);
      } else goToFinished(info, pathname);
    })();
    return;
  }

  goToFinished(info, pathname);
}

/** Navigate to the end-credits screen: replace the full player (the credits page takes
 * its place), else push over whatever content route is showing. */
function goToFinished(info: FinishedBook, pathname: string): void {
  const href = finishedHref(info.connectionId, info.libraryId, info.path, true);
  if (pathname === '/player') router.replace(href);
  else router.push(href);
}
