import { create } from 'zustand';

import { type OrderingPicks, parsePicks } from '@/lib/series-orderings';
import { getItem, setItem } from '@/lib/storage';

// A device preference, not per-server state: family keys are community-metadata
// series ids, the same on every server. Deliberately NOT in session.ts's
// SCOPED_STORAGE_KEYS, so neither storage-reset axis wipes it.
const KEY = 'audiosilo.seriesOrderings';

type SeriesOrderingsState = {
  /** Family key (`familyKey`) -> the id of the reading order the reader chose. */
  picks: OrderingPicks;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Remember a reading order for a family (see `@/lib/series-orderings`). */
  pick: (family: string, viewId: string) => void;
};

/**
 * The reader's remembered reading order per series family, persisted on the device
 * through the shared storage helper (AsyncStorage on native, localStorage on web) -
 * the settings store's convention. Hydrated once at boot from `_layout.tsx`.
 */
export const useSeriesOrderings = create<SeriesOrderingsState>()((set, get) => ({
  picks: {},
  hydrated: false,
  hydrate: async () => {
    const saved = parsePicks(await getItem<unknown>(KEY));
    // A pick made before hydration finished (a fast tap on a cold start) wins over
    // the stored one - it is the newer statement of what the reader wants. It was
    // held back from storage (see `pick`), so write the merged map now.
    const pending = get().picks;
    const picks = { ...saved, ...pending };
    set({ picks, hydrated: true });
    if (Object.keys(pending).length > 0) void setItem(KEY, picks);
  },
  pick: (family, viewId) => {
    if (get().picks[family] === viewId) return;
    const picks = { ...get().picks, [family]: viewId };
    set({ picks });
    // Before hydration the in-memory map is only this session's picks; writing it
    // would clobber every other family's stored pick. `hydrate` persists the merge.
    if (get().hydrated) void setItem(KEY, picks);
  },
}));
