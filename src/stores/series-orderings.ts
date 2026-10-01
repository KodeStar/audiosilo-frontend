import { create } from 'zustand';

import { type OrderingPicks, parsePicks } from '@/lib/series-orderings';
import { persistedDocument } from '@/lib/storage';

// A device preference, not per-server state: family keys are community-metadata
// series ids, the same on every server. Deliberately NOT in session.ts's
// SCOPED_STORAGE_KEYS, so neither storage-reset axis wipes it.
const stored = persistedDocument<OrderingPicks>('audiosilo.seriesOrderings', parsePicks);

type SeriesOrderingsState = {
  /** Family key (`familyKey`) -> the id of the reading order the reader chose. */
  picks: OrderingPicks;
  hydrate: () => Promise<void>;
  /** Remember a reading order for a family (see `@/lib/series-orderings`). */
  pick: (family: string, viewId: string) => void;
};

/**
 * The reader's remembered reading order per series family, persisted on the device
 * under the shared hydration rule (`persistedDocument`: a pick made before hydration
 * finished wins, and never clobbers another family's). Hydrated once at boot from
 * `_layout.tsx`.
 */
export const useSeriesOrderings = create<SeriesOrderingsState>()((set, get) => ({
  picks: {},
  hydrate: () => stored.hydrate({}, (picks) => set({ picks })),
  pick: (family, viewId) => {
    if (get().picks[family] === viewId) return;
    const picks = { ...get().picks, [family]: viewId };
    set({ picks });
    stored.write({ [family]: viewId }, picks);
  },
}));
