import { useEffect, useState } from 'react';

import type { ListeningSpanEvent } from '@/api/types';

import {
  type ConnectionSyncState,
  onOutboxChange,
  outboxEvents,
  syncStateOf,
} from './listening-outbox';
import { pendingSaves } from './progress-sync';

/** What the account's Listening sync card shows of one connection. */
type ListeningSyncView = {
  /** Listens waiting: the outbox's events plus the open span while offline. */
  waiting: number;
  lastSyncAt?: string;
  failed: NonNullable<ConnectionSyncState['failed']>;
};

const EMPTY: ListeningSyncView = { waiting: 0, failed: [] };

/** Re-run `read` now and on every outbox change, while mounted; `null` key reads nothing.
 * A value `same` as the one held keeps it (no re-render: an outbox change that left this
 * reader's part alone). */
function useOutboxRead<T>(
  key: string | null,
  read: () => Promise<T>,
  initial: T,
  same: (a: T, b: T) => boolean,
): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const run = () =>
      void read()
        .then((v) => live && setValue((prev) => (same(prev, v) ? prev : v)))
        .catch(() => undefined);
    run();
    const stop = onOutboxChange(run);
    return () => {
      live = false;
      stop();
    };
    // `read` is rebuilt each render; `key` names what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return value;
}

/** One connection's listening sync: the waiting count, the last sync and the
 * couldn't-sync list, kept current as the outbox changes. */
export function useListeningSync(connectionId: string | undefined): ListeningSyncView {
  return useOutboxRead(
    connectionId ?? null,
    async () => {
      const cid = connectionId as string;
      const [{ listens }, state] = await Promise.all([pendingSaves(cid), syncStateOf(cid)]);
      return { waiting: listens, lastSyncAt: state.lastSyncAt, failed: state.failed ?? [] };
    },
    EMPTY,
    (a, b) =>
      a.waiting === b.waiting && a.lastSyncAt === b.lastSyncAt && sameIds(a.failed, b.failed),
  );
}

/** When `connectionId`'s server last answered this device's listening (Home's pill), read
 * while `active`. */
export function useLastSyncAt(connectionId: string | undefined, active = true): string | undefined {
  return useOutboxRead(
    connectionId && active ? connectionId : null,
    async () => (await syncStateOf(connectionId as string)).lastSyncAt,
    undefined,
    (a, b) => a === b,
  );
}

const sameIds = (
  a: readonly { event: { id: string } }[],
  b: readonly { event: { id: string } }[],
) => a.length === b.length && a.every((x, i) => x.event.id === b[i].event.id);

/** This device's listen events waiting to sync for one book (the history's "Waiting to
 * sync" rows), oldest first. */
export function usePendingListens(
  connectionId: string | undefined,
  libraryId: number,
  path: string,
): ListeningSpanEvent[] {
  return useOutboxRead(
    connectionId ? `${connectionId}\u0000${libraryId}\u0000${path}` : null,
    async () =>
      (await outboxEvents(connectionId))
        .map((e) => e.event)
        .filter(
          (e): e is ListeningSpanEvent =>
            e.kind === 'listen' && e.library_id === libraryId && e.path === path,
        ),
    [],
    (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id),
  );
}
