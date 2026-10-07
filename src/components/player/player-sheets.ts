import { useSegments } from 'expo-router';
import { create } from 'zustand';

import type { CompanionTab } from './companion/companion-model';
import { useCompanion } from './companion/companion-store';

/** The player's sheets and overlays anyone can ask to open. */
export type PlayerSheet =
  | 'speed'
  | 'sleep'
  | 'bookmark'
  | 'output'
  | 'chapters'
  | 'shortcuts'
  /** The full player's companion on `useCompanion`'s tab (`openCompanion`): its sheet on a
   * phone, the column or the inline companion wider. */
  | 'companion'
  /** Up next on a tablet or phone (a desktop has the drawer; `openUpNext`). */
  | 'upnext';

type PlayerSheetsState = {
  /** The sheet asked for, or null. */
  open: PlayerSheet | null;
  openSheet: (sheet: PlayerSheet) => void;
  /** Show the companion on `tab`: one intent for every caller (the phone's chips, the
   * reveal toast's Show); the active sheet host picks the form by its measured layout. */
  openCompanion: (tab: CompanionTab) => void;
  close: () => void;
};

/**
 * Which player sheet is open, as a store anyone can drive: the web keyboard (Z opens the
 * sleep sheet, ? the shortcuts), a palette action, a button. A request says WHAT, never
 * where: the active `PlayerSheetHost` (`player-sheet-host.tsx`, mounted in the full
 * player and once in the shell) renders it from `open` in the form its layout calls for
 * and closes it with `close()`. One sheet at a time, so opening one replaces another.
 *
 * `shortcuts` is rendered by `ShortcutsDialog` (web shell).
 */
export const usePlayerSheets = create<PlayerSheetsState>()((set) => ({
  open: null,
  openSheet: (open) => set({ open }),
  openCompanion: (tab) => {
    useCompanion.getState().setTab(tab);
    set({ open: 'companion' });
  },
  close: () => set({ open: null }),
}));

/** Where a sheet host is mounted: inside the full player, or once in the app shell (for
 * the docked bar and the mini players). */
export type SheetHostScope = 'player' | 'shell';

/** Whether the full player (a root route) is the top layer. */
export function usePlayerOnTop(): boolean {
  return (useSegments() as string[])[0] === 'player';
}

/**
 * Which host renders an overlay the full player and the shell both mount (the player's
 * sheets, Up next's sheet): the full player's while it is on top, the shell's otherwise.
 * Exactly one, so a sheet asked for over the full player never also opens behind it (on
 * native the player is a root `fullScreenModal`, so the shell's overlays sit under it,
 * invisible but live).
 */
export function hostIsActive(scope: SheetHostScope, playerOnTop: boolean): boolean {
  return scope === 'player' || !playerOnTop;
}
