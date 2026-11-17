import { router, usePathname } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { resolveClient } from '@/api/connection-clients';
import type { BookRef } from '@/api/types';
import { finishedHref } from '@/lib/paths';
import { sharedStart } from '@/lib/shared-start';
import { whenActive } from '@/lib/when-active';
import { useSleepTimer } from '@/playback/sleep-timer';
import { selectBookKey, selectIsEnded, usePlayer, type FinishedBook } from '@/playback/store';
import { resolveUpNext } from '@/playback/up-next-resolver';
import { upNextSources } from '@/playback/up-next-sources';
import { useSettings } from '@/stores/settings';

import { advanceTo, useAutoPlayHold } from './end-of-book';
import { dropFromQueue } from './queue-drop';

/** The route on screen, as `BookEndedRoute` last saw it; null while no root layout is
 * mounted (a car-only session: Android's headless task, a CarPlay-first launch). */
let route: string | null = null;
/** Calls waiting for a route (`whenRouted`). */
const routeWaiters = new Set<() => void>();

/** `fn` once a root layout reports its route: at once when one is mounted. The credits can
 * only open over a navigator that is there. */
function whenRouted(fn: () => void): void {
  if (route !== null) fn();
  else routeWaiters.add(fn);
}

/**
 * Renders nothing: tells the end-of-book flow which route is on screen (the credits replace
 * the full player, and are never stacked on themselves). Mounted once at the root, so it
 * covers every layout (phone modal + wide desktop).
 */
export function BookEndedRoute() {
  const pathname = usePathname();
  useEffect(() => {
    route = pathname;
    const waiting = [...routeWaiters];
    routeWaiters.clear();
    for (const fn of waiting) fn();
  }, [pathname]);
  useEffect(
    () => () => {
      route = null;
    },
    [],
  );
  return null;
}

/**
 * The end-of-book flow, framework-free so it runs with no React tree too: a book played only
 * from the car (no root layout mounted) is marked finished, leaves Up next and plays on into
 * the next one there as well (fe#158). It watches the player store for the edge into `ended`
 * (the book reached its natural end; the store keeps nowPlaying populated in that state), once
 * per ended book and only for a real book (nowPlaying set). The flow runs a microtask later:
 * the engine's own `ended` handling (the finish it sends, the final save) reads nowPlaying
 * after the store set the snapshot, and `finishBook` clears it. Shared (`sharedStart`): the
 * root layout starts it, and so does the car's stack. Returns the stop.
 */
export const startBookEndWatch = sharedStart(() =>
  usePlayer.subscribe((state, prev) => {
    if (!selectIsEnded(state) || selectIsEnded(prev) || !state.nowPlaying) return;
    const ended = state.nowPlaying;
    void Promise.resolve().then(() => {
      const now = usePlayer.getState();
      if (now.nowPlaying === ended && selectIsEnded(now)) bookEnded();
    });
  }),
);

function bookEnded(): void {
  const player = usePlayer.getState();
  // Did the book end under a sleep timer armed for it? Read before finishBook clears
  // nowPlaying, because the timer then ends itself on its next tick as a timer whose book
  // went away. Such an end IS the timer's stop: the listener asked it to end the night,
  // so nothing may play on by itself (`useAutoPlayHold`). Written at every end, so a
  // later end without a timer is not held by this one.
  const timer = useSleepTimer.getState();
  const bookKey = selectBookKey(player);
  const sleptThrough = timer.phase !== 'idle' && timer.bookKey === bookKey;
  useAutoPlayHold.setState({ key: sleptThrough ? bookKey : null });
  // Capture the finished book's identity and tear playback down (persists finished,
  // clears nowPlaying, optionally deletes the local copy). Done even when the credits
  // screen is already open, so a natural end ALWAYS finalizes the book - otherwise
  // (with auto-play off, the default, or no next book) nowPlaying would stay stuck in
  // `ended` and the mini-player would remain docked showing the just-finished book.
  const info = player.finishBook();
  if (!info) return;
  handleBookEnded(info, () => route, sleptThrough);
}

/** Decide what to do once the current book has ended, given the route we're on and
 * whether it ended under the sleep timer (`sleptThrough`: then nothing starts by itself;
 * the credits hold their countdown through `useAutoPlayHold`). */
function handleBookEnded(
  info: FinishedBook,
  pathname: () => string | null,
  sleptThrough: boolean,
): void {
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
  // listener is asleep, and the next book would play to nobody all night. With no root
  // layout mounted (a car-only session) it goes the same way, and the credits wait for one.
  if (AppState.currentState !== 'active' || pathname() === null) {
    // Now, not when the deferred credits open: they may never (something else is loaded
    // on return, or iOS ends the suspended app overnight), and the book is finished
    // whether or not the next one starts.
    void dropFromQueue(info.connectionId, [finished]);
    void (async () => {
      if (!sleptThrough && useSettings.getState().autoPlayNext && (await playNextInPlace(info)))
        return;
      whenActive(() =>
        whenRouted(() => {
          // Something else started meanwhile (the lock screen, a widget, the car): the
          // credits would talk over it.
          if (usePlayer.getState().nowPlaying) return;
          goToFinished(info, pathname());
        }),
      );
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
  pathname: () => string | null,
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
function goToFinished(info: FinishedBook, pathname: string | null): void {
  const href = finishedHref(info.connectionId, info.libraryId, info.path, true);
  if (pathname === '/player') router.replace(href);
  else router.push(href);
}
