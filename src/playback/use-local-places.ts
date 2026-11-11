import { useEffect, useMemo, useState } from 'react';

import type { Progress } from '@/api/types';

import { onOutboxChange } from './listening-outbox';
import {
  type LocalPlaces,
  type PlacedProgress,
  readLocalPlaces,
  withLocalPlaces,
} from './progress-sync';

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
  const [places, setPlaces] = useState<LocalPlaces | null>(null);
  // What the list says, not its identity: a list rebuilt each render reads nothing again.
  const said = rows
    .map((r) => `${r.connectionId}\u0000${r.library_id}\u0000${r.path}\u0000${r.updated_at}`)
    .join('\n');
  useEffect(() => {
    let live = true;
    const read = () =>
      void readLocalPlaces()
        .then((p) => live && setPlaces(p))
        .catch(() => undefined);
    read();
    const stop = onOutboxChange(read);
    return () => {
      live = false;
      stop();
    };
  }, [said]);
  return useMemo(() => withLocalPlaces(rows, places), [rows, places]);
}
