import { useEffect, useState } from 'react';

import { heldByKey } from '@/downloads/downloads-view';
import { engine } from '@/downloads/engine';
import { useDownloads } from '@/downloads/store';
import type { StorageEstimate } from '@/downloads/types';

export type StorageReading = {
  /** The engine's measurement of everything downloaded (null until read). */
  measured: number | null;
  /** Room for downloads, when the platform can tell (null otherwise or until read). */
  estimate: StorageEstimate | null;
  /** What each download held as `measured` was read (`heldByKey`): the measure counts it,
   * so only what is written after it adds to it (`grownSince`, PLAYER-05). */
  heldAtMeasure: Record<string, number>;
};

/** The registry's finished downloads, as a string that only changes when a book lands
 * or leaves (not on every progress tick). */
const finishedSignature = (s: ReturnType<typeof useDownloads.getState>) =>
  Object.entries(s.entries)
    .filter(([, e]) => e.status === 'downloaded')
    .map(([k]) => k)
    .sort()
    .join('|');

/** How much the downloads take and how much room is left, read again whenever a book
 * finishes downloading or is removed. Both reads are async (Cache API, disk). */
export function useStorage(): StorageReading {
  const signature = useDownloads(finishedSignature);
  const [reading, setReading] = useState<StorageReading>({
    measured: null,
    estimate: null,
    heldAtMeasure: {},
  });
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      engine.totalBytesUsed().catch(() => null),
      engine.storageEstimate().catch(() => null),
    ]).then(([measured, estimate]) => {
      if (cancelled) return;
      const heldAtMeasure = heldByKey(useDownloads.getState().entries);
      setReading({ measured, estimate, heldAtMeasure });
    });
    return () => {
      cancelled = true;
    };
  }, [signature]);
  return reading;
}
