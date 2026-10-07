import { create } from 'zustand';

import type { CompanionTab } from './companion-model';

type CompanionState = {
  /** The tab asked for (null: the first the book has). Kept across opens of the player,
   * so the companion comes back where the listener left it. */
  tab: CompanionTab | null;
  /** The book (its `contentKey`) whose hidden characters and recaps the listener chose
   * to see. ONE reveal shared by Who's who and Story so far, as on the book page; another
   * book starts hidden again. */
  revealedKey: string | null;
  /** The characters the last natural chapter crossing revealed, in that book: Who's who
   * marks them "Just met". */
  justMet: { key: string; ids: string[] } | null;
  setTab: (tab: CompanionTab) => void;
  setRevealed: (key: string, shown: boolean) => void;
  markJustMet: (key: string, ids: string[]) => void;
};

/**
 * The companion's state outside any one view, so the docked companion column, the
 * tablet's inline companion, the phone's companion sheet and the reveal toast's "Show"
 * all agree. Memory only: a new session starts hidden.
 */
export const useCompanion = create<CompanionState>()((set) => ({
  tab: null,
  revealedKey: null,
  justMet: null,
  setTab: (tab) => set({ tab }),
  setRevealed: (key, shown) => set({ revealedKey: shown ? key : null }),
  markJustMet: (key, ids) => set({ justMet: { key, ids } }),
}));

/** Whether the listener chose to see `key`'s hidden entries. */
export const selectRevealed = (key: string | null) => (s: CompanionState) =>
  key !== null && s.revealedKey === key;

/** The ids Who's who marks "Just met" in `key` (empty for any other book). */
export const selectJustMet = (key: string | null) => (s: CompanionState) =>
  key !== null && s.justMet?.key === key ? s.justMet.ids : NONE;

const NONE: string[] = [];
