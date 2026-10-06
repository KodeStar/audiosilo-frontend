import { useEffect, useState } from 'react';

import { anyOffline, useReachability } from '@/api/reachability';
import { getItem } from '@/lib/storage';

import { syncPill } from './home-model';

/** progress-sync's offline replay queue (its private `QUEUE_KEY`). Home only counts the
 * entries: playback internals stay untouched (decision 7), and the module exposes no
 * reader, so the stored list is the one honest source of "saved here, not yet synced". */
const PROGRESS_QUEUE_KEY = 'audiosilo.progressQueue';
/** How often the count is read again while Home is open (the queue drains on its own). */
const RECHECK_MS = 20_000;

/** Saves waiting in the offline queue, re-read as servers come and go and every 20 s. */
function usePendingSaves(): number {
  const online = useReachability((s) => s.online);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let live = true;
    const read = () =>
      void getItem<unknown[]>(PROGRESS_QUEUE_KEY)
        .then((q) => live && setPending(Array.isArray(q) ? q.length : 0))
        .catch(() => undefined);
    read();
    const timer = setInterval(read, RECHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [online]);
  return pending;
}

/** The greeting's sync pill (see `syncPill`), from the offline queue, the servers'
 * reachability and the newest saved progress. */
export function useSyncPill(lastSaved: string | undefined) {
  const pending = usePendingSaves();
  const offline = useReachability((s) => anyOffline(s.online));
  return syncPill({ offline, pending, lastSaved });
}
