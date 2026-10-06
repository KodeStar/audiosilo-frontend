import { create } from 'zustand';

import { useRecentSearches } from '@/stores/search';

type PaletteState = {
  open: boolean;
  query: string;
  openPalette: () => void;
  close: () => void;
  setQuery: (query: string) => void;
};

/**
 * The web command palette's state (`CommandPalette`): open or not, and the query
 * (cleared on every open). Its recent searches are the Search screen's
 * (`useRecentSearches`), read on the first open.
 */
export const usePalette = create<PaletteState>()((set) => ({
  open: false,
  query: '',
  openPalette: () => {
    set({ open: true, query: '' });
    useRecentSearches.getState().hydrate();
  },
  close: () => set({ open: false }),
  setQuery: (query) => set({ query }),
}));
