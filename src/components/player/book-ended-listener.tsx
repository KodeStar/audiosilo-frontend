import { router, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { resolveClient } from '@/api/connection-clients';
import { finishedHref, playerHref } from '@/lib/paths';
import { resolveNextBook } from '@/playback/next-book';
import { selectIsEnded, usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';

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

  useEffect(() => {
    const prev = wasEnded.current;
    wasEnded.current = isEnded;
    // Only on the false→true edge, and only with a real book loaded.
    if (!isEnded || prev || !nowPlaying) return;
    handleBookEnded(pathname);
  }, [isEnded, nowPlaying, pathname]);

  return null;
}

/** Decide what to do when the current book ends, given the route we're on. */
function handleBookEnded(pathname: string): void {
  // Capture the finished book's identity and tear playback down (persists finished,
  // clears nowPlaying, optionally deletes the local copy). Done even when the credits
  // screen is already open, so a natural end ALWAYS finalizes the book - otherwise (with
  // auto-play off, the default, or no next book) nowPlaying would stay stuck in `ended`
  // and the mini-player would remain docked showing the just-finished book.
  const info = usePlayer.getState().finishBook();
  if (!info) return;

  // Already showing the end-credits screen: it drives its own countdown + Play next from
  // here, so don't navigate again (that would stack a duplicate /finished).
  if (pathname === '/finished') return;

  // Locked / backgrounded with auto-play on: iOS may suspend JS soon after audio stops,
  // so don't gamble on a visible countdown - resolve the next book and jump straight to
  // the player. Fall back to the normal end-credits navigation if there's no next book.
  if (AppState.currentState !== 'active' && useSettings.getState().autoPlayNext) {
    void (async () => {
      const client = resolveClient(info.connectionId);
      const next = client ? await resolveNextBook(client, info.libraryId, info.path) : null;
      if (next) {
        // Replace only when we're already on the player; otherwise push, so we don't drop
        // whatever route the user was on (library/downloads/...) from the back stack.
        const href = playerHref(info.connectionId, info.libraryId, next.path);
        if (pathname === '/player') router.replace(href);
        else router.push(href);
      } else goToFinished(info.connectionId, info.libraryId, info.path, pathname);
    })();
    return;
  }

  goToFinished(info.connectionId, info.libraryId, info.path, pathname);
}

/** Navigate to the end-credits screen: replace the full player (the credits page takes
 * its place), else push over whatever content route is showing. */
function goToFinished(
  connectionId: string,
  libraryId: number,
  path: string,
  pathname: string,
): void {
  const href = finishedHref(connectionId, libraryId, path, true);
  if (pathname === '/player') router.replace(href);
  else router.push(href);
}
