import { useMemo } from 'react';

import type { Progress } from '@/api/types';

import {
  type LocalPlaces,
  type PlacedProgress,
  readLocalPlaces,
  withLocalPlaces,
} from './progress-sync';
import { useOutboxRead } from './use-listening-sync';

/** Each read of this device's records is a new one: the list is worked out again. */
const never = () => false;

/**
 * `rows` (a progress list) with each book where Resume would play it (`withLocalPlaces`,
 * fe#211): Home's percent and the player's then come from the same place after an offline
 * run, before the server's list has heard of it. This device's records are read when the
 * list changes and as the outbox does (a closed span, a sync); until then, and when they
 * can't be read, the list as it came.
 */
export function useWithLocalPlaces<T extends Progress & { connectionId: string }>(
  rows: readonly T[],
): readonly (T & PlacedProgress)[] {
  // What the list says, not its identity: a list rebuilt with the same rows reads nothing
  // again.
  const said = useMemo(
    () =>
      rows
        .map((r) => `${r.connectionId}\u0000${r.library_id}\u0000${r.path}\u0000${r.updated_at}`)
        .join('\n'),
    [rows],
  );
  const places = useOutboxRead<LocalPlaces | null>(said, readLocalPlaces, null, never);
  return useMemo(() => withLocalPlaces(rows, places), [rows, places]);
}
