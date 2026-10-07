import { create } from 'zustand';

import { getItem, setItem } from '@/lib/storage';

/** The search text, shared so it survives the Search screen remounting, plus a focus
 * request: the tablet/desktop top bar's omnisearch jumps to the Search tab and bumps
 * `focusRequest`, and the Search screen focuses its input on each bump (whether or not
 * the tab was already mounted). */
type SearchState = {
  query: string;
  setQuery: (q: string) => void;
  focusRequest: number;
  requestFocus: () => void;
};

export const useSearchStore = create<SearchState>()((set) => ({
  query: '',
  setQuery: (query) => set({ query }),
  focusRequest: 0,
  requestFocus: () => set((s) => ({ focusRequest: s.focusRequest + 1 })),
}));

/** Recent searches kept on this device. */
const MAX_RECENT = 5;

/** The key predates the Search screen sharing the list (the palette had it first). */
const RECENT_KEY = 'audiosilo.paletteRecent';

const fold = (s: string) => s.toLocaleLowerCase();

/** Puts a search at the front of the recent list: trimmed, de-duplicated ignoring case,
 * at most `MAX_RECENT`. An empty search changes nothing. */
export function addRecent(recent: readonly string[], query: string): string[] {
  const q = query.trim();
  if (!q) return [...recent];
  return [q, ...recent.filter((r) => fold(r) !== fold(q))].slice(0, MAX_RECENT);
}

type RecentState = {
  /** Newest first, at most five (`addRecent`). */
  recent: string[];
  /** Read the stored list, once (later calls do nothing). */
  hydrate: () => void;
  /** Keep a search that led somewhere. */
  remember: (query: string) => void;
  clear: () => void;
};

let hydrated = false;

/**
 * The listener's recent searches, ONE list for the Search screen and the web command
 * palette, persisted per device (not per server: they are the listener's words). Read
 * lazily by whichever opens first; a search remembered before the read finished stays
 * newest.
 */
export const useRecentSearches = create<RecentState>()((set, get) => ({
  recent: [],
  hydrate: () => {
    if (hydrated) return;
    hydrated = true;
    void getItem<unknown>(RECENT_KEY).then((saved) => {
      if (!Array.isArray(saved)) return;
      const stored = saved.filter((q): q is string => typeof q === 'string');
      // Replay the early ones oldest first on top of the stored list (and store the
      // merge, which they overwrote).
      const early = get().recent;
      const recent = [...early]
        .reverse()
        .reduce((list, q) => addRecent(list, q), stored.slice(0, MAX_RECENT));
      set({ recent });
      if (early.length > 0) void setItem(RECENT_KEY, recent);
    });
  },
  remember: (query) => {
    const recent = addRecent(get().recent, query);
    set({ recent });
    void setItem(RECENT_KEY, recent);
  },
  clear: () => {
    set({ recent: [] });
    void setItem(RECENT_KEY, []);
  },
}));
