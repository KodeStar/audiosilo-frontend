import { create } from 'zustand';

/** Shared search text so the desktop top bar and the search screen are one
 * input (avoids the confusing "two search bars"). */
type SearchState = {
  query: string;
  setQuery: (q: string) => void;
};

export const useSearchStore = create<SearchState>()((set) => ({
  query: '',
  setQuery: (query) => set({ query }),
}));
