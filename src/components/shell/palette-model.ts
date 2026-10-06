import type { IconName } from '@/components/ui/icon';

/**
 * The web command palette's model (STYLEGUIDE section 8, "Command palette"): which items
 * show for a query, in which groups, and how the keyboard moves through them. Pure - the
 * component (`command-palette.tsx`) builds the candidates from the stores and runs them.
 */

export type PaletteGroupKey =
  'actions' | 'continue' | 'books' | 'series' | 'authors' | 'narrators' | 'characters' | 'goTo';

/** A book row's cover: resolved against its own server by the row. */
export type PaletteCover = { connectionId: string; libraryId: number; path: string };

export type PaletteItem = {
  /** Unique within the palette; also the option's DOM id suffix. */
  id: string;
  title: string;
  subtitle?: string;
  /** Actions, Go to and series show a glyph tile; books show their cover; people and
   * characters their initials (`token`). */
  icon?: IconName;
  cover?: PaletteCover;
  token?: PaletteToken;
  run: () => void;
};

/** A person's or character's initials disc in place of an icon. */
export type PaletteToken = { kind: 'author' | 'narrator' | 'character'; name: string };

export type PaletteGroup = {
  key: PaletteGroupKey;
  items: PaletteItem[];
  /** A quiet line under the items that is not an option (the characters a listener
   * hasn't met yet, counted). A group with a note shows even with no items. */
  note?: string;
  /** The flat (listbox) index of the group's first item: item `i` is option `start + i`. */
  start: number;
};

/** At most this many book results, and Continue listening rows on an empty query. */
export const MAX_BOOKS = 8;
export const MAX_CONTINUE = 4;
/** At most this many series, authors, narrators and characters each. */
export const MAX_NAMED = 3;

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
 * Continue listening -, then (with a query) Series, Authors, Narrators and Characters
 * (already matched by the search model, `@/components/search/search-model`), then Go to.
 * Empty groups are dropped, except Characters when it has a note (the unmet count).
 */
export function buildPaletteGroups({
  query,
  actions,
  books,
  continueListening,
  series = [],
  authors = [],
  narrators = [],
  characters = [],
  charactersNote,
  goTo,
}: {
  query: string;
  actions: PaletteItem[];
  /** Results of the cross-server search for `query` (already matched by the server). */
  books: PaletteItem[];
  continueListening: PaletteItem[];
  series?: PaletteItem[];
  authors?: PaletteItem[];
  narrators?: PaletteItem[];
  /** Characters the listener has met (the model never hands over the others). */
  characters?: PaletteItem[];
  /** "2 more matches after your place in the book": a count, never a name. */
  charactersNote?: string;
  goTo: PaletteItem[];
}): PaletteGroup[] {
  const q = query.trim();
  const named = (key: PaletteGroupKey, items: PaletteItem[]) => ({
    key,
    items: q ? items.slice(0, MAX_NAMED) : [],
  });
  const candidates: Omit<PaletteGroup, 'start'>[] = [
    {
      key: 'actions',
      items: q ? actions.filter((a) => matches(a.title, q) || matches(a.subtitle, q)) : actions,
    },
    q
      ? { key: 'books', items: books.slice(0, MAX_BOOKS) }
      : { key: 'continue', items: continueListening.slice(0, MAX_CONTINUE) },
    named('series', series),
    named('authors', authors),
    named('narrators', narrators),
    { ...named('characters', characters), note: q ? charactersNote : undefined },
    { key: 'goTo', items: q ? goTo.filter((g) => matches(g.title, q)) : goTo },
  ];
  const groups: PaletteGroup[] = [];
  let start = 0;
  for (const g of candidates) {
    if (g.items.length === 0 && !g.note) continue;
    groups.push({ ...g, start });
    start += g.items.length;
  }
  return groups;
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
