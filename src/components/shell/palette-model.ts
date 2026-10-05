import type { IconName } from '@/components/ui/icon';

/**
 * The web command palette's model (STYLEGUIDE section 8, "Command palette"): which items
 * show for a query, in which groups, and how the keyboard moves through them. Pure - the
 * component (`command-palette.tsx`) builds the candidates from the stores and runs them.
 */

export type PaletteGroupKey = 'actions' | 'continue' | 'books' | 'goTo';

/** A book row's cover: resolved against its own server by the row. */
export type PaletteCover = { connectionId: string; libraryId: number; path: string };

export type PaletteItem = {
  /** Unique within the palette; also the option's DOM id suffix. */
  id: string;
  title: string;
  subtitle?: string;
  /** Actions and Go to show a glyph tile; books show their cover. */
  icon?: IconName;
  cover?: PaletteCover;
  run: () => void;
};

export type PaletteGroup = { key: PaletteGroupKey; items: PaletteItem[] };

/** At most this many book results, and Continue listening rows on an empty query. */
export const MAX_BOOKS = 8;
export const MAX_CONTINUE = 4;
/** Recent searches kept on this device. */
export const MAX_RECENT = 5;

const fold = (s: string) => s.toLocaleLowerCase();

/** Where `query` first occurs in `text` (case-insensitive), as [start, end), or null. The
 * component bolds that span in `brand-ink`. */
export function matchRange(text: string, query: string): [number, number] | null {
  const q = query.trim();
  if (!q) return null;
  const i = fold(text).indexOf(fold(q));
  return i < 0 ? null : [i, i + q.length];
}

const matches = (text: string | undefined, q: string) => !!text && fold(text).includes(fold(q));

/**
 * The groups for a query, in order: Actions (matching their title, or their subtitle once
 * there is a query), then Books (the server search's results) - or, with no query,
 * Continue listening - then Go to. Empty groups are dropped.
 */
export function buildPaletteGroups({
  query,
  actions,
  books,
  continueListening,
  goTo,
}: {
  query: string;
  actions: PaletteItem[];
  /** Results of the cross-server search for `query` (already matched by the server). */
  books: PaletteItem[];
  continueListening: PaletteItem[];
  goTo: PaletteItem[];
}): PaletteGroup[] {
  const q = query.trim();
  const groups: PaletteGroup[] = [
    {
      key: 'actions',
      items: q ? actions.filter((a) => matches(a.title, q) || matches(a.subtitle, q)) : actions,
    },
    q
      ? { key: 'books', items: books.slice(0, MAX_BOOKS) }
      : { key: 'continue', items: continueListening.slice(0, MAX_CONTINUE) },
    { key: 'goTo', items: q ? goTo.filter((g) => matches(g.title, q)) : goTo },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** The groups' items in display order: the listbox's options, indexed by the selection. */
export function flattenGroups(groups: PaletteGroup[]): PaletteItem[] {
  return groups.flatMap((g) => g.items);
}

/** Moves the active option by `delta`, clamped to the list (no wrap, like the prototype). */
export function moveSelection(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index + delta));
}

/** Puts a search at the front of the recent list: trimmed, de-duplicated ignoring case,
 * at most `MAX_RECENT`. An empty search changes nothing. */
export function addRecent(recent: readonly string[], query: string): string[] {
  const q = query.trim();
  if (!q) return [...recent];
  return [q, ...recent.filter((r) => fold(r) !== fold(q))].slice(0, MAX_RECENT);
}

/** The slice of a DOM KeyboardEvent the global shortcut reads. */
export type ShortcutKey = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
};

/**
 * Whether a keydown opens the palette: ⌘K / Ctrl+K, or a bare `/` (STYLEGUIDE section
 * 11). Never while typing in a field (`editable`): a `/` there is just a slash.
 */
export function isPaletteShortcut(e: ShortcutKey, editable: boolean): boolean {
  if (editable || e.altKey) return false;
  if (e.key === '/' && !e.metaKey && !e.ctrlKey) return true;
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
}

/** The omnisearch's key hint: ⌘K on Apple platforms, Ctrl K elsewhere. */
export function shortcutHint(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘K' : 'Ctrl K';
}
