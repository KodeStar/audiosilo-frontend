import { useSegments } from 'expo-router';
import { create } from 'zustand';

/** The player's sheets and overlays anyone can ask to open. */
export type PlayerSheet =
  | 'speed'
  | 'sleep'
  | 'bookmark'
  | 'output'
  | 'chapters'
  | 'shortcuts'
  /** The full player's companion as a sheet (a phone); its tab is `useCompanion`'s. */
  | 'companion';

type PlayerSheetsState = {
  /** The sheet asked for, or null. */
  open: PlayerSheet | null;
  openSheet: (sheet: PlayerSheet) => void;
  close: () => void;
};

/**
 * Which player sheet is open, as a store anyone can drive: the web keyboard (Z opens the
 * sleep sheet, ? the shortcuts), a palette action, a button. The surface that OWNS a
 * sheet (the docked bar on tablet/desktop, the full player when it is open) renders it
 * from `open === '<sheet>'` and closes it with `close()`; a sheet nothing renders stays a
 * no-op request. One sheet at a time, so opening one replaces another.
 *
 * `shortcuts` is rendered by `ShortcutsDialog` (web shell); the rest by `PlayerSheetHost`
 * (`player-sheet-host.tsx`), mounted in the full player and once in the shell.
 */
export const usePlayerSheets = create<PlayerSheetsState>()((set) => ({
  open: null,
  openSheet: (open) => set({ open }),
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
