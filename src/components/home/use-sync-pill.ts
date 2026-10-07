import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';

import { anyOffline, useReachability } from '@/api/reachability';
import { pendingSaveCount } from '@/playback/progress-sync';

import { syncPill } from './home-model';

/** How often the count is read again while Home is open (the queue drains on its own). */
const RECHECK_MS = 20_000;

/** Saves waiting in the offline queue, re-read as servers come and go and every 20 s
 * while Home is the screen in front (a tab kept alive behind another reads nothing). */
export function usePendingSaves(): number {
  const online = useReachability((s) => s.online);
  const focused = useIsFocused();
  const [pending, setPending] = useState(0);
  useEffect(() => {
    if (!focused) return;
    let live = true;
    const read = () =>
      void pendingSaveCount()
        .then((n) => live && setPending(n))
        .catch(() => undefined);
    read();
    const timer = setInterval(read, RECHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [online, focused]);
  return pending;
}

/** The greeting's sync pill (see `syncPill`), from the offline queue, the servers'
 * reachability and the newest saved progress. */
export function useSyncPill(lastSaved: string | undefined) {
  const pending = usePendingSaves();
  const offline = useReachability((s) => anyOffline(s.online));
  return syncPill({ offline, pending, lastSaved });
}
