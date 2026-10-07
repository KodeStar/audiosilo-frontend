import { router, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { resolveClient } from '@/api/connection-clients';
import { finishedHref } from '@/lib/paths';
import { useLatestRef } from '@/lib/use-latest';
import { whenActive } from '@/lib/when-active';
import { selectIsEnded, usePlayer, type FinishedBook } from '@/playback/store';
import { resolveUpNext } from '@/playback/up-next-resolver';
import { upNextSources } from '@/playback/up-next-sources';
import { useSettings } from '@/stores/settings';

import { startBookInPlace } from './start-book';
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
  // The route at the moment the deferred credits open (the app came back), not at the end.
  const pathnameRef = useLatestRef(pathname);
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
    handleBookEnded(info, () => pathnameRef.current, dropFromQueue);
  }, [isEnded, nowPlaying, pathnameRef, dropFromQueue]);

  return null;
}

/** Decide what to do once the current book has ended, given the route we're on. */
function handleBookEnded(
  info: FinishedBook,
  pathname: () => string,
  dropFromQueue: ReturnType<typeof useQueueDrop>,
): void {
  // A finished book is no longer "up next". The credits opened by the end (`auto=1`)
  // take it off the queue themselves (so does "Mark as finished", which opens them the
  // same way); the two paths that don't open them do it here.
  const finished = { library_id: info.libraryId, path: info.path };

  // Already showing the end-credits screen: it drives its own countdown + Play now from
  // here, so don't navigate again (that would stack a duplicate /finished).
  if (pathname() === '/finished') {
    void dropFromQueue([finished]);
    return;
  }

  // Locked / backgrounded: NEVER navigate. The player and the credits are root
  // fullScreenModals, and iOS cannot present one from the background (the app came back
  // to a black screen that never recovered). With auto-play on, iOS may also suspend JS
  // soon after audio stops, so don't gamble on a visible countdown either: resolve the
  // next book (the same answer the credits screen would give: Up next first, then the
  // series) and start it in place; on return the mini player / docked bar shows it. With
  // nothing to play (or auto-play off, or a start that failed), the credits open once
  // the app is back in the foreground.
  if (AppState.currentState !== 'active') {
    void (async () => {
      if (
        useSettings.getState().autoPlayNext &&
        (await playNextInPlace(info, finished, dropFromQueue))
      )
        return;
      whenActive(() => {
        // Something else started meanwhile (the lock screen, a widget): the credits
        // would talk over it.
        if (usePlayer.getState().nowPlaying) return;
        goToFinished(info, pathname());
      });
    })();
    return;
  }

  goToFinished(info, pathname());
}

/** Resolve and start the next book without opening the player. True once it is on its
 * way (and off Up next with the finished book). */
async function playNextInPlace(
  info: FinishedBook,
  finished: { library_id: number; path: string },
  dropFromQueue: ReturnType<typeof useQueueDrop>,
): Promise<boolean> {
  const client = resolveClient(info.connectionId);
  if (!client) return false;
  try {
    const { next } = await resolveUpNext(upNextSources(client, info.connectionId), info);
    if (!next || !(await startBookInPlace(next))) return false;
    // It is the book you're on now, no longer up next.
    void dropFromQueue(next.queueEntry ? [finished, next.queueEntry] : [finished]);
    return true;
  } catch (err) {
    console.warn('[end-of-book] could not start the next book', err);
    return false;
  }
}

/** Navigate to the end-credits screen: replace the full player (the credits page takes
 * its place), else push over whatever content route is showing. */
function goToFinished(info: FinishedBook, pathname: string): void {
  const href = finishedHref(info.connectionId, info.libraryId, info.path, true);
  if (pathname === '/player') router.replace(href);
  else router.push(href);
}
