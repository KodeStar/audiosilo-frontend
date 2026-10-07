import { create } from 'zustand';

/** The player's sheets and overlays anyone can ask to open. */
export type PlayerSheet = 'speed' | 'sleep' | 'bookmark' | 'output' | 'chapters' | 'shortcuts';

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
 * `shortcuts` is rendered by `ShortcutsDialog` (web shell).
 */
export const usePlayerSheets = create<PlayerSheetsState>()((set) => ({
  open: null,
  openSheet: (open) => set({ open }),
  close: () => set({ open: null }),
}));
