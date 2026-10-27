import { create } from 'zustand';

import { useGlobalShortcut } from '@/lib/keyboard';
import { useRecentSearches } from '@/stores/search';

import { isPaletteShortcut } from './palette-model';

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

/**
 * The palette's global shortcuts (web): ⌘K / Ctrl+K and `/` open it from any tab page -
 * not over the full player, not over another dialog, and never while typing in a field.
 * Here, not with `CommandPalette`, so the keys work from the first paint while the palette
 * itself loads after it (the web shell defers it); it opens on the open state when in.
 */
export function usePaletteShortcut(enabled: boolean) {
  const openPalette = usePalette((s) => s.openPalette);
  useGlobalShortcut(enabled, isPaletteShortcut, openPalette);
}
