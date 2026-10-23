import { router, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { resolveClient } from '@/api/connection-clients';
import type { BookRef } from '@/api/types';
import { finishedHref } from '@/lib/paths';
import { useLatestRef } from '@/lib/use-latest';
import { whenActive } from '@/lib/when-active';
import { useSleepTimer } from '@/playback/sleep-timer';
import { selectBookKey, selectIsEnded, usePlayer, type FinishedBook } from '@/playback/store';
import { resolveUpNext } from '@/playback/up-next-resolver';
import { upNextSources } from '@/playback/up-next-sources';
import { useSettings } from '@/stores/settings';

import { advanceTo, useAutoPlayHold } from './end-of-book';
import { dropFromQueue } from './queue-drop';

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

  useEffect(() => {
    const prev = wasEnded.current;
    wasEnded.current = isEnded;
    // Only on the false→true edge, and only with a real book loaded.
    if (!isEnded || prev || !nowPlaying) return;
    // Did the book end under a sleep timer armed for it? Read before finishBook clears
    // nowPlaying, because the timer then ends itself on its next tick as a timer whose book
    // went away. Such an end IS the timer's stop: the listener asked it to end the night,
    // so nothing may play on by itself (`useAutoPlayHold`). Written at every end, so a
    // later end without a timer is not held by this one.
    const timer = useSleepTimer.getState();
    const bookKey = selectBookKey(usePlayer.getState());
    const sleptThrough = timer.phase !== 'idle' && timer.bookKey === bookKey;
    useAutoPlayHold.setState({ key: sleptThrough ? bookKey : null });
    // Capture the finished book's identity and tear playback down (persists finished,
    // clears nowPlaying, optionally deletes the local copy). Done even when the credits
    // screen is already open, so a natural end ALWAYS finalizes the book - otherwise
    // (with auto-play off, the default, or no next book) nowPlaying would stay stuck in
    // `ended` and the mini-player would remain docked showing the just-finished book.
    const info = usePlayer.getState().finishBook();
    if (!info) return;
    handleBookEnded(info, () => pathnameRef.current, sleptThrough);
  }, [isEnded, nowPlaying, pathnameRef]);

  return null;
}

/** Decide what to do once the current book has ended, given the route we're on and
 * whether it ended under the sleep timer (`sleptThrough`: then nothing starts by itself;
 * the credits hold their countdown through `useAutoPlayHold`). */
function handleBookEnded(info: FinishedBook, pathname: () => string, sleptThrough: boolean): void {
  // A finished book is no longer "up next". The credits opened by the end (`auto=1`)
  // take it off the queue themselves (so does "Mark as finished", which opens them the
  // same way); the two paths that don't open them right away do it here, at once.
  const finished: BookRef = { library_id: info.libraryId, path: info.path };

  if (info.episode) {
    endEpisode(info, finished, pathname, sleptThrough);
    return;
  }

  // Already showing the end-credits screen: it drives its own countdown + Play now from
  // here (the countdown held after an end under the sleep timer), so don't navigate again
  // (that would stack a duplicate /finished).
  if (pathname() === '/finished') {
    void dropFromQueue(info.connectionId, [finished]);
    return;
  }

  // Locked / backgrounded: NEVER navigate. The player and the credits are root
  // fullScreenModals, and iOS cannot present one from the background (the app came back
  // to a black screen that never recovered). With auto-play on, iOS may also suspend JS
  // soon after audio stops, so don't gamble on a visible countdown either: resolve the
  // next book (the same answer the credits screen would give: Up next first, then the
  // series) and start it in place; on return the mini player / docked bar shows it. With
  // nothing to play (or auto-play off, or a start that failed), the credits open once
  // the app is back in the foreground. So they do after an end under the sleep timer: the
  // listener is asleep, and the next book would play to nobody all night.
  if (AppState.currentState !== 'active') {
    // Now, not when the deferred credits open: they may never (something else is loaded
    // on return, or iOS ends the suspended app overnight), and the book is finished
    // whether or not the next one starts.
    void dropFromQueue(info.connectionId, [finished]);
    void (async () => {
      if (!sleptThrough && useSettings.getState().autoPlayNext && (await playNextInPlace(info)))
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

/**
 * The end of a podcast episode (Bridge Phase 2d-1): never the end credits (an episode has
 * no series, rating or next book). It leaves Up next, and with auto-play on (and not
 * under the sleep timer) the next item of Up next starts in place; else playback stops,
 * and a full player left open on it closes once the app is in the foreground.
 */
function endEpisode(
  info: FinishedBook,
  finished: BookRef,
  pathname: () => string,
  sleptThrough: boolean,
): void {
  void dropFromQueue(info.connectionId, [finished]);
  void (async () => {
    if (!sleptThrough && useSettings.getState().autoPlayNext && (await playNextInPlace(info, true)))
      return;
    whenActive(() => {
      if (usePlayer.getState().nowPlaying || pathname() !== '/player') return;
      if (router.canGoBack()) router.back();
    });
  })();
}

/** Resolve the next book and start it without opening the player (`advanceTo`). True
 * once it is on its way (and off Up next). `queueOnly`: only Up next's head (after an
 * episode, which has no series or folder to follow). */
async function playNextInPlace(info: FinishedBook, queueOnly = false): Promise<boolean> {
  const client = resolveClient(info.connectionId);
  if (!client) return false;
  const { next } = await resolveUpNext(upNextSources(client, info.connectionId), info, {
    queueOnly,
  });
  return !!next && (await advanceTo(next));
}

/** Navigate to the end-credits screen: replace the full player (the credits page takes
 * its place), else push over whatever content route is showing. */
function goToFinished(info: FinishedBook, pathname: string): void {
  const href = finishedHref(info.connectionId, info.libraryId, info.path, true);
  if (pathname === '/player') router.replace(href);
  else router.push(href);
}
