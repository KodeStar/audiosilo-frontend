import { create } from 'zustand';

import { resolveClient } from '@/api/connection-clients';
import { CapabilityError, cachedCapability, qk, queueQuery, removeFromQueue } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { BookRef, QueueEntry } from '@/api/types';
import { entryHolds, type UpNextBook } from '@/playback/up-next-resolver';

import { startBookInPlace } from './start-book';

/**
 * The book that ended while the listener's sleep timer was running for it, by its
 * `contentKey` (memory only). The listener asked the timer to stop for the night, and the
 * end of the book is where it stopped, so nothing plays on by itself after it: the
 * background start in place is skipped (`BookEndedListener`) and the credits hold their
 * countdown (`EndCredits`; Play now still plays). Another book started there would play to
 * nobody for hours and move its saved place with it. Written at every end of a book (null
 * when no timer ran for it), so a later end is never held by an old one.
 */
export const useAutoPlayHold = create<{ key: string | null }>(() => ({ key: null }));

/**
 * Take books off ONE connection's Up next queue at the end of a book: the book that
 * just finished, and the queued book that now plays (it is the book you're on, as Up
 * next's own Play now does). Each goes by the stored entry's own path (removes are
 * exact; the entry may be the book folder above a part path), looked up in the queue at
 * call time (the cached one, else read once), so a book that isn't queued sends
 * nothing. A removed entry also leaves the cached queue at once, so a later call for the
 * same book (the credits opened on return, after the end already dropped it) sends
 * nothing again. Only on a server the cache knows has `queue`. Quiet: it is
 * housekeeping, so a failure is never shown and never reaches the reachability tracker.
 * Framework-free: the end of a book can run with no screen mounted.
 */
export async function dropFromQueue(
  connectionId: string,
  books: readonly BookRef[],
): Promise<void> {
  const client = resolveClient(connectionId);
  if (!client || books.length === 0 || cachedCapability(connectionId, 'queue') !== true) return;
  const entries =
    queryClient.getQueryData<QueueEntry[]>(qk.queue(connectionId)) ??
    (await queryClient.fetchQuery(queueQuery(connectionId, client)).catch(() => undefined));
  if (!entries) return;
  const held = entries.filter((e) => books.some((b) => entryHolds(e, b.library_id, b.path)));
  for (const e of held) {
    try {
      await removeFromQueue(connectionId, client, { libraryId: e.library_id, path: e.path });
      queryClient.setQueryData<QueueEntry[]>(qk.queue(connectionId), (cached) =>
        cached?.filter((c) => c.library_id !== e.library_id || c.path !== e.path),
      );
    } catch (err) {
      if (!(err instanceof CapabilityError))
        console.warn('[up-next] could not take a played book off the queue', err);
    }
  }
}

/**
 * Play `next` after a book ended, the one way the end of a book moves on (the credits'
 * Play now and countdown, the background auto-play): start it in place
 * (`startBookInPlace`, no screen involved), then take it off Up next. Resolves `true`
 * once it is on its way; `false` when it could not start (its connection gone, or its
 * book could not be fetched), and then it stays on Up next. The finished book is not
 * this function's business: it leaves Up next where it is finished, whether or not the
 * next one starts (`BookEndedListener`, the credits). Showing the player is the caller's
 * choice (`navigateWhenActive`).
 */
export async function advanceTo(next: UpNextBook): Promise<boolean> {
  try {
    if (!(await startBookInPlace(next))) return false;
  } catch (err) {
    console.warn('[end-of-book] could not start the next book', err);
    return false;
  }
  if (next.queueEntry) void dropFromQueue(next.connectionId, [next.queueEntry]);
  return true;
}
