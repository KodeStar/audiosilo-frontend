import { resolveClient } from '@/api/connection-clients';
import { CapabilityError, cachedCapability, qk, queueQuery, removeFromQueue } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { BookRef, QueueEntry } from '@/api/types';
import { entryHolds } from '@/playback/up-next-resolver';

/** The queue entries a removal is on its way for, by connection and entry. */
const removing = new Set<string>();
const entryKeyOf = (cid: string, e: BookRef) => JSON.stringify([cid, e.library_id, e.path]);

/**
 * Take books off ONE connection's Up next queue at the end of a book: the book that
 * just finished, and the queued book that now plays (it is the book you're on, as Up
 * next's own Play now does). Each goes by the stored entry's own path (removes are
 * exact; the entry may be the book folder above a part path), looked up in the queue at
 * call time (the cached one, else read once and kept), so a book that isn't queued sends
 * nothing. A removed entry also leaves the cached queue at once, so a later call for the
 * same book (the credits opened on return, after the end already dropped it) sends
 * nothing again, and one already being removed is not sent twice (a start in place drops
 * the book it starts, and the end of a book drops the same one). Only on a server the
 * cache knows has `queue`. Quiet: it is
 * housekeeping, so a failure is never shown and never reaches the reachability tracker.
 * Framework-free: the end of a book can run with no screen mounted.
 */
export async function dropFromQueue(
  connectionId: string,
  books: readonly BookRef[],
): Promise<void> {
  const client = resolveClient(connectionId);
  if (!client || books.length === 0 || cachedCapability(connectionId, 'queue') !== true) return;
  // The read it makes is kept for the session (`gcTime: Infinity`): with nothing showing
  // Up next no observer holds the queue, so it would be collected after the default five
  // minutes and every later start would read `/queue` again. Up next's own views still
  // refetch it when they open (staleTime 0, `up-next-sources`).
  const entries =
    queryClient.getQueryData<QueueEntry[]>(qk.queue(connectionId)) ??
    (await queryClient
      .fetchQuery({ ...queueQuery(connectionId, client), gcTime: Infinity })
      .catch(() => undefined));
  if (!entries) return;
  const held = entries.filter(
    (e) =>
      books.some((b) => entryHolds(e, b.library_id, b.path)) &&
      !removing.has(entryKeyOf(connectionId, e)),
  );
  // All of them at once: a call meanwhile for an entry this one reaches later sends nothing.
  for (const e of held) removing.add(entryKeyOf(connectionId, e));
  for (const e of held) {
    const key = entryKeyOf(connectionId, e);
    try {
      await removeFromQueue(connectionId, client, { libraryId: e.library_id, path: e.path });
      queryClient.setQueryData<QueueEntry[]>(qk.queue(connectionId), (cached) =>
        cached?.filter((c) => c.library_id !== e.library_id || c.path !== e.path),
      );
    } catch (err) {
      if (!(err instanceof CapabilityError))
        console.warn('[up-next] could not take a played book off the queue', err);
    } finally {
      removing.delete(key);
    }
  }
}
