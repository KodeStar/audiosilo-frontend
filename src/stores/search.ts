import { create } from 'zustand';

/** The search text, shared so it survives the Search screen remounting, plus a focus
 * request: the tablet/desktop top bar's omnisearch jumps to the Search tab and bumps
 * `focusRequest`, which the Search screen keys its input on (a fresh mount with
 * `autoFocus` takes the focus, whether or not the tab was already mounted). */
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
