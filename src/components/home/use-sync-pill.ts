import { hashKey, useQueryClient } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { qk } from '@/api/hooks';
import { anyOffline, useReachability } from '@/api/reachability';
import { onOutboxChange } from '@/playback/listening-outbox';
import { pendingSaves } from '@/playback/progress-sync';
import { useListeningSync } from '@/playback/use-listening-sync';

import { syncPill } from './home-model';

/** How often the count is read again while Home is open (the queue drains on its own). */
const RECHECK_MS = 20_000;

/** What waits to sync: the offline queue's saves and Sync v2's listens. */
export type PendingCounts = { saves: number; listens: number };

const NONE: PendingCounts = { saves: 0, listens: 0 };

/**
 * Saves waiting in the offline queue and listens in the listening outbox (all of them, or
 * `connectionId`'s; a change to the outbox reads them again at once), re-read as
 * servers come and go and every 20 s while `active` (Home passes whether it is the screen
 * in front: a tab kept alive behind another reads nothing). `pollWhenClear: false` keeps
 * the 20 s re-read to the times it can change anything: something is waiting, or a server
 * is offline (the player chrome, which is up for whole sessions, polls while playing:
 * a save refused with a 5xx is queued with the server still online). Without polling it
 * still reads once more 20 s after a change, so a save still in flight then (the pause
 * save) is counted.
 */
export function usePendingCounts({
  active = true,
  pollWhenClear = true,
  connectionId,
}: { active?: boolean; pollWhenClear?: boolean; connectionId?: string } = {}): PendingCounts {
  const online = useReachability((s) => s.online);
  const [pending, setPending] = useState<PendingCounts>(NONE);
  const total = pending.saves + pending.listens;
  const poll = pollWhenClear || total > 0 || anyOffline(online);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const read = () =>
      void pendingSaves(connectionId)
        .then(
          (n) =>
            live &&
            setPending((prev) => (prev.saves === n.saves && prev.listens === n.listens ? prev : n)),
        )
        .catch(() => undefined);
    read();
    const stopWatch = onOutboxChange(read);
    const interval = poll ? setInterval(read, RECHECK_MS) : undefined;
    const settle = poll ? undefined : setTimeout(read, RECHECK_MS);
    return () => {
      live = false;
      stopWatch();
      clearInterval(interval);
      clearTimeout(settle);
    };
  }, [online, active, poll, connectionId]);
  return pending;
}

/** `usePendingCounts` as one number: everything waiting to sync. */
export function usePendingSaves(
  opts: { active?: boolean; pollWhenClear?: boolean; connectionId?: string } = {},
): number {
  const { saves, listens } = usePendingCounts(opts);
  return saves + listens;
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
  const { saves, listens } = usePendingCounts({ active: useIsFocused() });
  const online = useReachability((s) => s.online);
  const fetchedAt = useProgressFetchedAt(newest?.connectionId);
  // Sync v2: when the newest progress's server last answered this device's listening.
  const { lastSyncAt } = useListeningSync(newest?.connectionId);
  return syncPill({ online, pending: saves + listens, listens, newest, fetchedAt, lastSyncAt });
}
