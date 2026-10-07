import { useEffect, useState } from 'react';

import { getItem } from '@/lib/storage';
import { DRIFT_STORAGE_KEY, type DriftRecords, pruneDrifts } from '@/playback/drift';

/**
 * This device's drift-off records (`src/playback/drift.ts`), read once when the Diary
 * shows and never written here: a record says how many minutes the listener slept
 * through, so a drift-off's strip can offer "Jump back N minutes". The playback side
 * takes a record the next time its book plays, so a book played since has none (the
 * strip then offers its bookmark instead).
 */
export function useDriftRecords(): DriftRecords {
  const [records, setRecords] = useState<DriftRecords>({});
  useEffect(() => {
    let live = true;
    getItem<unknown>(DRIFT_STORAGE_KEY)
      .then((raw) => {
        if (live) setRecords(pruneDrifts(raw, Date.now()));
      })
      .catch(() => {
        // unreadable storage: no records, so every strip offers its bookmark
      });
    return () => {
      live = false;
    };
  }, []);
  return records;
}
