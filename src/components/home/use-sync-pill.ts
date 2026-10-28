import { hashKey, useQueryClient } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { qk } from '@/api/hooks';
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

/** When this device last read `cid`'s progress list from its server (the query's
 * `dataUpdatedAt`, epoch ms; 0 before the first read). Read from the query cache without
 * an observer of its own, so it never fetches nor changes how the list is fetched. */
function useProgressFetchedAt(cid: string | undefined): number {
  const qc = useQueryClient();
  const cache = qc.getQueryCache();
  const hash = cid ? hashKey(qk.allProgress(cid)) : undefined;
  return useSyncExternalStore(
    // Only this list's events: Home's other queries never move it.
    (onChange) =>
      cache.subscribe((e) => {
        if (e.query.queryHash === hash) onChange();
      }),
    () => (cid ? (qc.getQueryState(qk.allProgress(cid))?.dataUpdatedAt ?? 0) : 0),
  );
}

/** The greeting's sync pill (see `syncPill`), from the offline queue, the servers'
 * reachability, the newest saved progress and when this device last read it. */
export function useSyncPill(newest: { at: string; connectionId: string } | undefined) {
  const pending = usePendingSaves({ active: useIsFocused() });
  const online = useReachability((s) => s.online);
  const fetchedAt = useProgressFetchedAt(newest?.connectionId);
  return syncPill({ online, pending, newest, fetchedAt });
}
