import { useEffect, useState } from 'react';

import { useReachability } from '@/api/reachability';

import {
  type ConnectionSyncState,
  onOutboxChange,
  type WaitingListen,
  waitingListens,
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
export function useOutboxRead<T>(
  key: string | null,
  read: () => Promise<T>,
  initial: T,
  same: (a: T, b: T) => boolean,
): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    let revision = 0;
    const run = () => {
      const current = ++revision;
      void read()
        .then((v) => live && revision === current && setValue((prev) => (same(prev, v) ? prev : v)))
        .catch(() => undefined);
    };
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
  // The open span counts only while its server can't be reached: read again as that flips
  // (the span is stored online too, so going offline changes nothing in the outbox).
  const reachable = useReachability((s) =>
    connectionId ? (s.online[connectionId] ?? true) : true,
  );
  return useOutboxRead(
    connectionId ? `${connectionId}|${reachable}` : null,
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

const NO_WAITING: WaitingListen[] = [];

/** The history views follow the waiting events and any offline span awaiting recovery. */
export function useWaitingListens(): WaitingListen[] {
  const offline = useReachability((s) =>
    Object.keys(s.online)
      .filter((cid) => !s.online[cid])
      .sort()
      .join('\n'),
  );
  return useOutboxRead(
    offline,
    waitingListens,
    NO_WAITING,
    (a, b) =>
      sameIds(a, b) &&
      a.every(
        (w, i) =>
          w.connectionId === b[i].connectionId &&
          w.event.ended_at === b[i].event.ended_at &&
          w.event.to_pos === b[i].event.to_pos,
      ),
  );
}
