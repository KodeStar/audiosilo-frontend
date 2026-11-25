import { resolveConnectionId } from '@/lib/connection-id';
import { tabChannel, type TabChannel } from '@/lib/tab-channel';

import { bookRefOf, type BookRef } from './types';

type Listener = (
  connectionId: string,
  books: readonly Pick<BookRef, 'libraryId' | 'path'>[],
) => void;
const listeners = new Set<Listener>();

// Older tabs also hear this name. Every message still carries just the book to read again.
let channel: TabChannel<BookRef> | null | undefined;
function finishChannel() {
  if (channel === undefined) channel = tabChannel<BookRef>('audiosilo-undone-finish');
  return channel;
}

export function setFinishChannelForTests(next: typeof channel): void {
  channel = next;
}

/** Tell the other tabs a finish or its Undo changed the book. */
export function tellFinishChangedElsewhere(ref: BookRef): void {
  finishChannel()?.post(bookRefOf(ref));
}

export function onFinishChangedElsewhere(listener: (ref: BookRef) => void): () => void {
  return finishChannel()?.subscribe(listener) ?? (() => {});
}

/** A successful PUT or sync reply makes the server's lists, stats and goal worth reading
 * again. The queues also run without the UI, so they announce delivery here. */
export function onFinishDelivered(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const finishDelivered: Listener = (connectionId, books) => {
  const cid = resolveConnectionId(connectionId);
  for (const listener of listeners) listener(cid, books);
  for (const book of books) tellFinishChangedElsewhere({ ...book, connectionId: cid });
};
