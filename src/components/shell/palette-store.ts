import { create } from 'zustand';

import { getItem, setItem } from '@/lib/storage';

import { addRecent, MAX_RECENT } from './palette-model';

/** This device's recent palette searches (not per server: they are the listener's words). */
const RECENT_KEY = 'audiosilo.paletteRecent';

type PaletteState = {
  open: boolean;
  query: string;
  /** Newest first, at most five (`addRecent`). */
  recent: string[];
  openPalette: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  /** Keep a search that led somewhere, for the recent chips. */
  remember: (query: string) => void;
};

let hydrated = false;

/**
 * The web command palette's state (`CommandPalette`): open or not, the query (cleared on
 * every open) and the recent searches, persisted per device and read on the first open.
 */
export const usePalette = create<PaletteState>()((set, get) => ({
  open: false,
  query: '',
  recent: [],
  openPalette: () => {
    set({ open: true, query: '' });
    if (hydrated) return;
    hydrated = true;
    void getItem<unknown>(RECENT_KEY).then((saved) => {
      if (!Array.isArray(saved)) return;
      const stored = saved.filter((q): q is string => typeof q === 'string');
      // A search remembered before the read finished stays newest: replay them oldest
      // first on top of the stored list (and store the merge, which they overwrote).
      const early = get().recent;
      const recent = [...early]
        .reverse()
        .reduce((list, q) => addRecent(list, q), stored.slice(0, MAX_RECENT));
      set({ recent });
      if (early.length > 0) void setItem(RECENT_KEY, recent);
    });
  },
  close: () => set({ open: false }),
  setQuery: (query) => set({ query }),
  remember: (query) => {
    const recent = addRecent(get().recent, query);
    set({ recent });
    void setItem(RECENT_KEY, recent);
  },
}));
