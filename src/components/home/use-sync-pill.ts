import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';

import { anyOffline, useReachability } from '@/api/reachability';
import { pendingSaveCount } from '@/playback/progress-sync';

import { syncPill } from './home-model';

/** How often the count is read again while Home is open (the queue drains on its own). */
const RECHECK_MS = 20_000;

/**
 * Saves waiting in the offline queue, re-read as servers come and go and every 20 s
 * while `active` (Home passes whether it is the screen in front: a tab kept alive behind
 * another reads nothing). `pollWhenClear: false` keeps the 20 s re-read to the times it
 * can change anything: something is waiting, or a server is offline (the player chrome,
 * which is up for whole sessions).
 */
export function usePendingSaves({
  active = true,
  pollWhenClear = true,
}: { active?: boolean; pollWhenClear?: boolean } = {}): number {
  const online = useReachability((s) => s.online);
  const [pending, setPending] = useState(0);
  const poll = pollWhenClear || pending > 0 || anyOffline(online);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const read = () =>
      void pendingSaveCount()
        .then((n) => live && setPending(n))
        .catch(() => undefined);
    read();
    const timer = poll ? setInterval(read, RECHECK_MS) : undefined;
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [online, active, poll]);
  return pending;
}

/** The greeting's sync pill (see `syncPill`), from the offline queue, the servers'
 * reachability and the newest saved progress. */
export function useSyncPill(lastSaved: string | undefined) {
  const pending = usePendingSaves({ active: useIsFocused() });
  const offline = useReachability((s) => anyOffline(s.online));
  return syncPill({ offline, pending, lastSaved });
}
