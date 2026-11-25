import { refreshDeliveredFinishes } from '@/api/hooks';
import { resolveConnectionId } from '@/lib/connection-id';
import { queryClient } from '@/api/provider';

import { onFinishChangedElsewhere } from './finish-delivery';
import type { BookRef } from './types';

/** How long the books of one delivery (one message each) gather before one refresh. */
const GATHER_MS = 50;

/** Read this tab's caches again when a sibling delivered or undid a finish. Only
 * the tab that changed the book sends the message, one per book: the books that arrive
 * together refresh their connection's list, stats and goal once. */
export function startFinishChangesElsewhere(): () => void {
  const pending = new Map<string, Pick<BookRef, 'libraryId' | 'path'>[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    for (const [cid, books] of pending) refreshDeliveredFinishes(queryClient, cid, books);
    pending.clear();
  };
  const stop = onFinishChangedElsewhere((ref) => {
    const cid = resolveConnectionId(ref.connectionId);
    const books = pending.get(cid) ?? [];
    books.push({ libraryId: ref.libraryId, path: ref.path });
    pending.set(cid, books);
    timer ??= setTimeout(flush, GATHER_MS);
  });
  return () => {
    stop();
    clearTimeout(timer);
    timer = undefined;
    pending.clear();
  };
}
