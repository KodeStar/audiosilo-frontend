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
  // Already showing the end-credits screen: it reacts to the ended transition itself
  // (its own countdown + finishBook), so the listener stays out of the way.
  if (pathname === '/finished') return;

  // Capture the finished book's identity and tear playback down (persists finished,
  // clears nowPlaying, optionally deletes the local copy).
  const info = usePlayer.getState().finishBook();
  if (!info) return;

  // Locked / backgrounded with auto-play on: iOS may suspend JS soon after audio stops,
  // so don't gamble on a visible countdown - resolve the next book and jump straight to
  // the player. Fall back to the normal end-credits navigation if there's no next book.
  if (AppState.currentState !== 'active' && useSettings.getState().autoPlayNext) {
    void (async () => {
      const client = resolveClient(info.connectionId);
      const next = client ? await resolveNextBook(client, info.libraryId, info.path) : null;
      if (next) router.replace(playerHref(info.connectionId, info.libraryId, next.path));
      else goToFinished(info.connectionId, info.libraryId, info.path, pathname);
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
