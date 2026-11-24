import { replaceEqualDeep } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { Progress } from '@/api/types';

import { onOutboxChange } from './listening-outbox';
import {
  type LocalPlaces,
  type PlacedProgress,
  readLocalPlaces,
  withLocalPlaces,
} from './progress-sync';

let places: LocalPlaces | null = null;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let revision = 0;

// A closed span can change the outbox, mirror and sync state together. Read once for
// every mounted list, and discard an older read that finishes after a newer one.
function refresh() {
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
    stop = onOutboxChange(refresh);
    refresh();
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

function placedSnapshot<T extends Progress & { connectionId: string }>(rows: readonly T[]) {
  let last: LocalPlaces | null = null;
  let value: readonly (T & PlacedProgress)[] = rows;
  return () => {
    if (last !== places) {
      last = places;
      value = replaceEqualDeep(value, withLocalPlaces(rows, places));
    }
    return value;
  };
}

/** Keep the scoped server rows and their metadata, with the places Resume uses.
 * An unrelated outbox change keeps the same rendered rows and lookup. */
export function useWithLocalPlaces<T extends Progress & { connectionId: string }>(
  rows: readonly T[],
): readonly (T & PlacedProgress)[] {
  useEffect(() => {
    if (rows.length) refresh();
  }, [rows]);
  const snapshot = useMemo(() => placedSnapshot(rows), [rows]);
  return useSyncExternalStore(rows.length ? subscribe : emptySubscription, snapshot, () => rows);
}
