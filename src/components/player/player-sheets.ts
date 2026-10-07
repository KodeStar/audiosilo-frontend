import { useSegments } from 'expo-router';
import { create } from 'zustand';

import type { EditorRequest } from '@/lib/annotation-request';

import type { CompanionTab } from './companion/companion-model';
import { useCompanion } from './companion/companion-store';

/** The player's sheets and overlays anyone can ask to open. */
export type PlayerSheet =
  | 'speed'
  | 'sleep'
  /** An action, not a sheet: a bookmark at the playing book's place (`addBookmarkHere`). */
  | 'bookmark'
  /** The bookmark or note editor on `editor` (`openEditor` only). */
  | 'editor'
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
  /** What the editor is open on while `open` is `'editor'`. Kept after `close()`, so the
   * sheet slides away with its content; another sheet clears it. */
  editor: EditorRequest | null;
  /** Open a sheet (the editor opens through `openEditor`). */
  openSheet: (sheet: Exclude<PlayerSheet, 'editor'>) => void;
  /** Open the bookmark or note editor on a book, which need not be the playing one. */
  openEditor: (request: EditorRequest) => void;
  /** Show the companion on `tab`: one intent for every caller (the phone's chips, the
   * reveal toast's Show); the active sheet host picks the form by its measured layout. */
  openCompanion: (tab: CompanionTab) => void;
  close: () => void;
};

/**
 * Which player sheet is open, as a store anyone can drive: the web keyboard (Z opens the
 * sleep sheet, ? the shortcuts), a palette action, a button, a bookmark row's Edit. A
 * request says WHAT, never where: the active `PlayerSheetHost` (`player-sheet-host.tsx`,
 * mounted in the full player and once in the shell) renders it from `open` in the form
 * its layout calls for and closes it with `close()`. One sheet at a time, so opening one
 * replaces another.
 *
 * `shortcuts` is rendered by `ShortcutsDialog` (web shell).
 */
export const usePlayerSheets = create<PlayerSheetsState>()((set) => ({
  open: null,
  editor: null,
  openSheet: (open) => set({ open, editor: null }),
  openEditor: (editor) => set({ open: 'editor', editor }),
  openCompanion: (tab) => {
    useCompanion.getState().setTab(tab);
    set({ open: 'companion', editor: null });
  },
  close: () => set({ open: null }),
}));

/** The requests that need a loaded book (Up next, the shortcuts overlay and the editor,
 * which carries its own book, do not). */
const BOOK_SHEETS: ReadonlySet<PlayerSheet> = new Set([
  'speed',
  'sleep',
  'bookmark',
  'output',
  'chapters',
  'companion',
]);

/**
 * What an active host shows for `request` (pure): a book's sheets only while a book is
 * loaded; Up next with or without one; the editor whatever plays, since it carries its
 * own book (a bookmark of a book that is not playing, on any connection).
 */
export function shownSheet(request: PlayerSheet | null, loaded: boolean): PlayerSheet | null {
  if (request === 'editor' || request === 'upnext') return request;
  return loaded ? request : null;
}

/**
 * Whether the open request goes when the book unloads (it ended, Mark as finished), so
 * the next book to load doesn't open it by itself. The editor stays: it is about its own
 * book, playing or not, and closing it would throw away what the listener is typing.
 */
export function dropsWithBook(open: PlayerSheet | null): boolean {
  return open !== null && BOOK_SHEETS.has(open);
}

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
