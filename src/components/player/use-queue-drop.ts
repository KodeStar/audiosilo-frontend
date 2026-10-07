import { useCallback } from 'react';

import { CapabilityError, qk, queueQuery, useRemoveFromQueue } from '@/api/hooks';
import { queryClient, useCid, useOptionalApi } from '@/api/provider';
import type { BookRef, QueueEntry, ServerInfo } from '@/api/types';
import { entryHolds } from '@/playback/up-next-resolver';

/**
 * Takes books off ONE connection's Up next queue at the end of a book: the book that
 * just finished, and the queued book that now plays (it is the book you're on, as Up
 * next's own Play now does). Each goes by the stored entry's own path (removes are
 * exact; the entry may be the book folder above a part path), looked up in the queue at
 * call time (the cached one, else read once on a server known to have `queue`), so a
 * book that isn't queued sends nothing. Quiet: it is
 * housekeeping, so a failure (a `CapabilityError` on a server without `queue`, which
 * sends nothing, or an outage) is never shown and never reaches the reachability
 * tracker.
 */
export function useQueueDrop(connectionId: string | undefined) {
  const cid = useCid(connectionId);
  const api = useOptionalApi(connectionId);
  const remove = useRemoveFromQueue(connectionId);
  const { mutateAsync } = remove;
  return useCallback(
    async (books: readonly BookRef[]) => {
      let entries = queryClient.getQueryData<QueueEntry[]>(qk.queue(cid));
      const queues = queryClient.getQueryData<ServerInfo>(qk.server(cid))?.capabilities.queue;
      if (!entries && queues && api)
        entries = await queryClient.fetchQuery(queueQuery(cid, api)).catch(() => undefined);
      if (!entries) return;
      const held = entries.filter((e) => books.some((b) => entryHolds(e, b.library_id, b.path)));
      for (const e of held) {
        try {
          await mutateAsync({ libraryId: e.library_id, path: e.path });
        } catch (err) {
          if (!(err instanceof CapabilityError))
            console.warn('[up-next] could not take a played book off the queue', err);
        }
      }
    },
    [cid, api, mutateAsync],
  );
}
