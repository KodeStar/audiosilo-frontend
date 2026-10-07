import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';

import { anyOffline, useReachability } from '@/api/reachability';
import { pendingSaveCount } from '@/playback/progress-sync';

import { syncPill } from './home-model';

/** How often the count is read again while Home is open (the queue drains on its own). */
const RECHECK_MS = 20_000;

/**
 * Saves waiting in the offline queue (all of them, or `connectionId`'s), re-read as
 * servers come and go and every 20 s while `active` (Home passes whether it is the screen
 * in front: a tab kept alive behind another reads nothing). `pollWhenClear: false` keeps
 * the 20 s re-read to the times it can change anything: something is waiting, or a server
 * is offline (the player chrome, which is up for whole sessions, polls while playing:
 * a save refused with a 5xx is queued with the server still online). Without polling it
 * still reads once more 20 s after a change, so a save still in flight then (the pause
 * save) is counted.
 */
export function usePendingSaves({
  active = true,
  pollWhenClear = true,
  connectionId,
}: { active?: boolean; pollWhenClear?: boolean; connectionId?: string } = {}): number {
  const online = useReachability((s) => s.online);
  const [pending, setPending] = useState(0);
  const poll = pollWhenClear || pending > 0 || anyOffline(online);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const read = () =>
      void pendingSaveCount(connectionId)
        .then((n) => live && setPending(n))
        .catch(() => undefined);
    read();
    const interval = poll ? setInterval(read, RECHECK_MS) : undefined;
    const settle = poll ? undefined : setTimeout(read, RECHECK_MS);
    return () => {
      live = false;
      clearInterval(interval);
      clearTimeout(settle);
    };
  }, [online, active, poll, connectionId]);
  return pending;
}

/** The greeting's sync pill (see `syncPill`), from the offline queue, the servers'
 * reachability and the newest saved progress. */
export function useSyncPill(lastSaved: string | undefined) {
  const pending = usePendingSaves({ active: useIsFocused() });
  const offline = useReachability((s) => anyOffline(s.online));
  return syncPill({ offline, pending, lastSaved });
}
