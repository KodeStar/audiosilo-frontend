import { onConnectionRemovedInOtherTab } from '@/stores/session';

import { stopPlaybackAndCloseSpan, usePlayer } from './store';

/**
 * Web: another tab removed a connection this tab is playing through. The removing tab
 * stopped its own playback through it first (`teardownBeforeTokenRevoke`); this tab stops
 * too, before the removal's cleanups run here (`onConnectionRemovedInOtherTab`), so the
 * stop's place and its span's close are written before the purges take them, not after.
 * Nothing is sent: the token is gone. The same when a sign-in here retires a stale identity
 * the book plays through (any platform: the connect flow runs no teardown of its own).
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
  return onConnectionRemovedInOtherTab(async (id) => {
    if (usePlayer.getState().nowPlaying?.connectionId !== id) return;
    await stopPlaybackAndCloseSpan(id);
  });
}
