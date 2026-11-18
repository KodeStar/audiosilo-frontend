import { onConnectionRemovedInOtherTab } from '@/stores/session';

import { stopPlaybackAndCloseSpan } from './store';

/**
 * Web: another tab removed a connection this tab is playing through. The removing tab
 * stopped its own playback through it first (`teardownBeforeTokenRevoke`); this tab stops
 * too, before the removal's cleanups run here (`onConnectionRemovedInOtherTab`), so the
 * stop's place and its span's close are written before the purges take them, not after.
 * Nothing is sent: the token is gone. Started with the root's services; returns the stop.
 */
export function startRemovedInOtherTab(): () => void {
  return onConnectionRemovedInOtherTab(stopPlaybackAndCloseSpan);
}
