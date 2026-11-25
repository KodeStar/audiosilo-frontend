import { replaceEqualDeep } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { SourcedProgress } from '@/api/hooks';
import { resolveConnectionId, sameConnection } from '@/lib/connection-id';
import { contentKey } from '@/lib/content-key';

import { onOutboxChange } from './listening-outbox';
import {
  type LocalPlaces,
  type PlacedProgress,
  readLocalPlaces,
  pendingFinishPlace,
  withLocalPlaces,
} from './progress-sync';

let places: LocalPlaces | null = null;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let revision = 0;

// A closed span can change the outbox, mirror and sync state together. Read once for
// every mounted list, and discard an older read that finishes after a newer one.
export function refreshLocalPlaces() {
  if (!listeners.size || timer !== undefined) return;
  const version = ++revision;
  timer = setTimeout(async () => {
    timer = undefined;
    try {
      const next = await readLocalPlaces();
      if (version !== revision) return;
      places = next;
      for (const notify of listeners) notify();
    } catch {
      // The last readable places still apply.
    }
  }, 100);
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  if (listeners.size === 1) {
    stop = onOutboxChange(refreshLocalPlaces);
    refreshLocalPlaces();
  }
  return () => {
    listeners.delete(notify);
    if (!listeners.size) {
      stop?.();
      clearTimeout(timer);
      timer = undefined;
      revision++;
      places = null;
    }
  };
}

const emptySubscription = () => () => {};

type Source = { id: string; name: string };
const noSources: readonly Source[] = [];

/** TanStack and the external store both compare by identity. Keep the last result
 * across storage reads when this list or book's displayed place has not changed. */
function localSnapshot<T>(initial: T, read: (local: LocalPlaces | null) => T) {
  let last: LocalPlaces | null = null;
  let value = initial;
  return () => {
    if (last !== places) {
      last = places;
      value = replaceEqualDeep(value, read(last));
    }
    return value;
  };
}

function listedPlaces(
  rows: readonly SourcedProgress[],
  sources: readonly Source[],
  local: LocalPlaces | null,
): readonly (SourcedProgress & PlacedProgress)[] {
  const placed = withLocalPlaces(rows, local);
  if (!local?.finishes?.size) return placed;
  // Under the id the finishes are kept by (`readLocalPlaces`): a row under the id the identity
  // migration moved its connection from is that book all the same, not one to add.
  const listed = new Set(
    rows.map((row) => contentKey(resolveConnectionId(row.connectionId), row.library_id, row.path)),
  );
  const added: SourcedProgress[] = [];
  for (const [key, finish] of local.finishes) {
    if (listed.has(key)) continue;
    const source = sources.find((s) => sameConnection(s.id, finish.connectionId));
    if (!source) continue;
    const place = pendingFinishPlace(local, source.id, finish.libraryId, finish.path);
    if (place) added.push({ ...place, connectionId: source.id, connectionName: source.name });
  }
  return added.length
    ? [...placed, ...added].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    : placed;
}

/** Keep the scoped server rows and their metadata, with the places Resume uses. A pending
 * finish on a previously unlisted book joins its own connection's list, even after reload. */
export function useWithLocalPlaces(
  rows: readonly SourcedProgress[],
  sources: readonly Source[] = noSources,
): readonly (SourcedProgress & PlacedProgress)[] {
  const active = rows.length > 0 || sources.length > 0;
  useEffect(() => {
    if (active) refreshLocalPlaces();
  }, [active, rows]);
  const snapshot = useMemo(
    () => localSnapshot(rows, (local) => listedPlaces(rows, sources, local)),
    [rows, sources],
  );
  return useSyncExternalStore(active ? subscribe : emptySubscription, snapshot, () => rows);
}

/** A queued finish for a tile or the book page. A write to a different book leaves this
 * subscriber's result alone. A newer server place stays ahead of the device's mark. */
export function usePendingFinish(
  connectionId: string,
  libraryId: number,
  path: string,
  active: boolean,
  row?: PlacedProgress | null,
) {
  const snapshot = useMemo(
    () =>
      localSnapshot<PlacedProgress | undefined>(undefined, (local) =>
        active ? pendingFinishPlace(local, connectionId, libraryId, path, row) : undefined,
      ),
    [connectionId, libraryId, path, row, active],
  );
  return useSyncExternalStore(active ? subscribe : emptySubscription, snapshot, () => undefined);
}
