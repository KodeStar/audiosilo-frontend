import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAllProgressAll, useCapability, useNextBook, useQueue } from '@/api/hooks';
import type { BookRef, QueueEntry } from '@/api/types';
import { useQueueActions } from '@/components/library/use-queue-actions';
import { usePlayBook } from '@/components/player/use-play-book';
import { toast } from '@/components/ui/toast';
import { useLayout } from '@/lib/layout';
import { usePlayer } from '@/playback/store';
import { useSession } from '@/stores/session';

import { pickSuggestions, progressIndex, queueConnectionId, queuedSeconds } from './up-next-model';
import { useUpNext } from './up-next-store';

/** The connection whose queue Up next shows (`queueConnectionId`). */
export function useUpNextConnection(): string | undefined {
  const loaded = usePlayer((s) => s.nowPlaying?.connectionId);
  const defaultId = useSession((s) => s.defaultConnectionId);
  const connections = useSession((s) => s.connections);
  return queueConnectionId(loaded, defaultId, connections);
}

/** The connection Up next shows and whether its server has a queue (`undefined` until
 * `/server` answers, so nothing flashes). */
export function useUpNextServer(): { cid: string | undefined; supported: boolean | undefined } {
  const cid = useUpNextConnection();
  return { cid, supported: useCapability('queue', cid) };
}

/** Up next for the entry points: whether the server has it and how many books are
 * queued. */
export function useUpNextBadge() {
  const { cid, supported } = useUpNextServer();
  const { data } = useQueue(cid);
  return { supported, count: data?.length ?? 0 };
}

/**
 * Everything the Up next panel shows and does, for ONE connection's queue: the entries,
 * the listener's place in each (from the cached progress list), the time queued, the
 * picks under the queue, and the writes. Every write keeps hidden rows safe: a move is
 * a positioned add (`position` = the index in the visible list), a removal is an
 * exact-path delete of the entry's own stored path, never a whole-list PUT.
 */
export function useUpNextData(cid: string | undefined) {
  const { t } = useTranslation();
  const queue = useQueue(cid);
  // The panel's own writes (Remove, a dropped book, a suggestion) go through the same
  // mutations, so one `busy` covers them all.
  const actions = useQueueActions(cid);
  const { add, remove, fail } = actions;
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const loaded = nowPlaying && nowPlaying.connectionId === cid ? nowPlaying : null;
  const next = useNextBook(loaded?.libraryId ?? 0, loaded?.path ?? '', !!loaded, cid);
  // The same cached list Home and the palette read; a mount doesn't refetch it.
  const { progress: allProgress } = useAllProgressAll({ refetchOnMount: false });

  const entries = queue.data;
  const mine = useMemo(() => allProgress.filter((p) => p.connectionId === cid), [allProgress, cid]);
  const progress = useMemo(() => progressIndex(mine), [mine]);
  const suggestions = useMemo(
    () =>
      pickSuggestions({
        next: next.data,
        current: loaded ? { library_id: loaded.libraryId, path: loaded.path } : undefined,
        queued: entries ?? [],
        inProgress: mine,
      }),
    [next.data, loaded, entries, mine],
  );

  /** Moves an entry to `to`, its index in the visible list. */
  const move = (entry: QueueEntry, to: number) =>
    add.mutateAsync({ libraryId: entry.library_id, path: entry.path, position: to }).then(
      () => true,
      (e: unknown) => {
        fail(e);
        return false;
      },
    );

  /** Takes every VISIBLE entry off, one exact-path delete each (rows the listener
   * can't see now stay stored), then offers one Undo that puts them back in order. */
  const clear = async (visible: readonly QueueEntry[]) => {
    const removed: QueueEntry[] = [];
    for (const e of visible) {
      try {
        await remove.mutateAsync({ libraryId: e.library_id, path: e.path });
        removed.push(e);
      } catch (err) {
        fail(err);
        break;
      }
    }
    if (removed.length === 0) return;
    toast({
      title: t('upnext.cleared', { count: removed.length }),
      action: {
        label: t('queue.undo'),
        onPress: () =>
          void (async () => {
            for (const [i, e] of removed.entries()) {
              try {
                await add.mutateAsync({ libraryId: e.library_id, path: e.path, position: i });
              } catch (err) {
                fail(err);
                return;
              }
            }
          })(),
      },
    });
  };

  /** Drops the entry after it started playing: no toast (it moved to "Now playing"). */
  const dropPlayed = (entry: BookRef) =>
    remove.mutateAsync({ libraryId: entry.library_id, path: entry.path }).catch(fail);

  return {
    entries,
    isLoading: queue.isLoading,
    error: queue.error,
    refetch: queue.refetch,
    progress,
    queuedSeconds: entries ? queuedSeconds(entries, progress) : 0,
    suggestions,
    move,
    clear,
    dropPlayed,
    actions,
    busy: actions.pending,
  };
}

/**
 * "Play now" for a queued book, through the one play path (`usePlayBook`): a phone
 * closes the sheet and opens the full player; a tablet or desktop starts it under the
 * docked bar. The entry leaves the queue once the book is on its way.
 */
export function usePlayNow(cid: string | undefined, dropPlayed: (e: BookRef) => unknown) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const play = usePlayBook();
  const closeSheet = useUpNext((s) => s.closeSheet);

  return async (entry: QueueEntry, title: string) => {
    if (!cid) return;
    if (phone) closeSheet();
    try {
      await play({ connectionId: cid, libraryId: entry.library_id, path: entry.path });
      void dropPlayed(entry);
    } catch {
      toast({ title: t('upnext.playFailed', { title }) });
    }
  };
}
