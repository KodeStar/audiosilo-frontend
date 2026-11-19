import { onConnectionGoingInOtherTab, onConnectionRemovedInOtherTab } from '@/stores/session';

import { flushConnectionSaves, stopPlaybackAndCloseSpan, usePlayer } from './store';

/**
 * Web: another tab is removing a connection this tab is playing through.
 *
 * - Before it revokes the token (`onConnectionGoingInOtherTab`, the removing tab waits a
 *   bounded time on it): this tab stops, and sends its place and its listening while the
 *   token still works (`flushConnectionSaves`), as the removing tab does for its own.
 * - Once it is removed (`onConnectionRemovedInOtherTab`: the stored list dropped it here, or
 *   the word came first), before the removal's cleanups run here: a book still playing
 *   through it stops, so the stop's place and its span's close are written before the purges
 *   take them, not after. Nothing goes through the session's clients: the token is gone,
 *   and this tab's list with it (on a server without `listening_sync` the client the player
 *   kept still PUTs the stop's place, and the server refuses it).
 *   The same when a sign-in here retires a stale identity the book plays through (any
 *   platform: the connect flow runs no teardown of its own).
 *
 * A tab with no book loaded through the connection does nothing: there is nothing to stop,
 * and waiting a turn into the outbox would take the span lock every tab shares (a
 * `localStorage` lease on plain http, on a background tab's slowed timers) once per open
 * tab, ahead of the purges. What such a tab still has waiting its turn is the removed
 * sign-in's, and is not appended once the purge ran (`connectionGeneration`).
 *
 * Started with the root's services; returns the stop.
 */
export function startRemovedInOtherTab(): () => void {
  const playingThrough = (id: string) => usePlayer.getState().nowPlaying?.connectionId === id;
  const stopGoing = onConnectionGoingInOtherTab((id) =>
    playingThrough(id) ? stopPlaybackAndCloseSpan(id).then(() => flushConnectionSaves(id)) : null,
  );
  const stopRemoved = onConnectionRemovedInOtherTab(async (id) => {
    if (!playingThrough(id)) return;
    await stopPlaybackAndCloseSpan(id);
  });
  return () => {
    stopGoing();
    stopRemoved();
  };
}
