import { Platform } from 'react-native';

import { networkChecked } from '@/api/address-route';
import { onForeground } from '@/lib/when-active';
import { flushReadingQueue } from '@/reader/reading-progress';

import { flushBookmarks } from './annotation-outbox';
import { flushQueue } from './progress-sync';

type Win = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * The stored offline queues (the legacy progress saves, the reader's places, the bookmarks
 * waiting for their server) replayed when
 * the app is picked up again: back in the foreground (the web: its tab shown again) and, on
 * the web, its window focused or the browser back online. A replay otherwise follows a save,
 * a reconnect or Home opening, so the saves of a replay that died with its tab (their claim
 * run out, `queue-claims.ts`) waited for the next of those. Started with the root's
 * services; returns the stop.
 */
export function startQueueReplays(
  win: Win | undefined = Platform.OS === 'web'
    ? (globalThis as { window?: Win }).window
    : undefined,
): () => void {
  const replay = () => {
    void flushQueue().catch(() => undefined);
    void flushReadingQueue().catch(() => undefined);
    void flushBookmarks().catch(() => undefined);
  };
  // On the foreground, once the address runner has checked the network (as the listening
  // outbox: a home address checked on the network before the suspend goes first).
  const stops = [onForeground(() => void networkChecked().then(replay))];
  if (typeof win?.addEventListener === 'function') {
    for (const type of ['focus', 'online'] as const) {
      win.addEventListener(type, replay);
      stops.push(() => win.removeEventListener(type, replay));
    }
  }
  return () => {
    for (const stop of stops) stop();
  };
}
