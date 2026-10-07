import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import {
  CapabilityError,
  useAddToQueue,
  useCapability,
  useQueue,
  useRemoveFromQueue,
} from '@/api/hooks';
import type { QueueEntry } from '@/api/types';
import { toast } from '@/components/ui/toast';

/**
 * The queue entry that holds a book, if any. An add resolves a part/disc path to its
 * book, so the entry's own path may be the book folder ABOVE the path asked about.
 */
export function findQueued(
  entries: readonly QueueEntry[] | undefined,
  libraryId: number,
  path: string,
): QueueEntry | undefined {
  return entries?.find(
    (e) => e.library_id === libraryId && (e.path === path || path.startsWith(`${e.path}/`)),
  );
}

/**
 * "Queue it" for any screen: Up next on ONE connection's server (the book's own; the
 * 1b mutations are bound to a connection, so a cross-server screen calls this per book,
 * as `QueueButton` does). Capability-gated: `supported` is false (hide the affordance)
 * until the server is known to advertise `queue`.
 * - `isQueued(libraryId, path)`: from the cached queue.
 * - `queue(libraryId, path)`: at the end, then a toast with Undo.
 * - `unqueue(libraryId, path)`: removes the entry by its OWN path (removes are exact),
 *   then a toast whose Undo puts it back where it was.
 * Both resolve to whether the change was made. A `CapabilityError` (no request was sent)
 * is swallowed quietly and never reaches the reachability tracker; a full queue and other
 * failures say so in a toast (`fail`, for a caller's own writes through `add`/`remove`,
 * the same mutations, so `pending` covers them too).
 */
export function useQueueActions(connectionId?: string) {
  const { t } = useTranslation();
  const supported = useCapability('queue', connectionId) === true;
  const { data: entries } = useQueue(connectionId);
  const add = useAddToQueue(connectionId);
  const remove = useRemoveFromQueue(connectionId);

  const fail = (e: unknown) => {
    if (e instanceof CapabilityError) return;
    toast({
      title: e instanceof ApiError && e.status === 409 ? t('queue.full') : t('queue.failed'),
    });
  };

  const removeEntry = (libraryId: number, entryPath: string) =>
    remove.mutateAsync({ libraryId, path: entryPath }).then(
      () => true,
      (e: unknown) => {
        fail(e);
        return false;
      },
    );

  const queue = async (libraryId: number, path: string) => {
    if (findQueued(entries, libraryId, path)) return true;
    try {
      const next = await add.mutateAsync({ libraryId, path });
      const added = findQueued(next, libraryId, path);
      toast({
        title: t('queue.added'),
        action: added
          ? { label: t('queue.undo'), onPress: () => void removeEntry(libraryId, added.path) }
          : undefined,
      });
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const unqueue = async (libraryId: number, path: string) => {
    const entry = findQueued(entries, libraryId, path);
    if (!entry || !entries) return false;
    const index = entries.indexOf(entry);
    if (!(await removeEntry(libraryId, entry.path))) return false;
    toast({
      title: t('queue.removed'),
      action: {
        label: t('queue.undo'),
        onPress: () =>
          void add
            .mutateAsync({ libraryId: entry.library_id, path: entry.path, position: index })
            .catch(fail),
      },
    });
    return true;
  };

  return {
    supported,
    isQueued: (libraryId: number, path: string) => !!findQueued(entries, libraryId, path),
    queue,
    unqueue,
    add,
    remove,
    fail,
    pending: add.isPending || remove.isPending,
  };
}
