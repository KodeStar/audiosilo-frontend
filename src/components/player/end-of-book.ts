import { create } from 'zustand';

import type { UpNextBook } from '@/playback/up-next-resolver';

import { dropFromQueue } from './queue-drop';
import { startBookInPlace } from './start-book';

export { dropFromQueue } from './queue-drop';

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
