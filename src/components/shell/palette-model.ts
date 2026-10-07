import type { TFunction } from 'i18next';

import type { IconName } from '@/components/ui/icon';
import type { ShortcutKey } from '@/lib/keyboard';

import type { Destination, TabName } from './destinations';

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

/** What the Actions group is built from: the app's state right now. */
export type ActionState = {
  /** The loaded book (none: no transport actions). `chapterName` is the current chapter's
   * label; `hasChapters` whether the book has real chapters. */
  nowPlaying: { title: string; chapterName: string | null; hasChapters: boolean } | null;
  isPlaying: boolean;
  /** The minutes the sleep action arms. */
  sleepMinutes: number;
  /** Up next is offered (the queue's server has `queue`), with this many books queued. */
  upNext: { count: number } | null;
  dark: boolean;
};

/** What each action does (the component wires the stores and the router). */
export type ActionRuns = Record<
  'toggle' | 'sleepMinutes' | 'sleepChapter' | 'player' | 'upNext' | 'appearance',
  () => void
>;

/**
 * The palette's Actions, only what the app can do right now: the transport (pause or
 * "Resume <chapter>"), the sleep timer (end of chapter only with real chapters: without
 * them it falls back to a short duration timer the label would misdescribe), the full
 * player - all three only with a book loaded -, Up next (only where it is offered) and
 * the light/dark switch. (Settings is a place, so it is in Go to.)
 */
export function buildActionItems(s: ActionState, run: ActionRuns, t: TFunction): PaletteItem[] {
  const items: PaletteItem[] = [];
  const np = s.nowPlaying;
  if (np) {
    items.push({
      id: 'toggle',
      title: s.isPlaying
        ? t('player.controls.pause')
        : t('palette.resume', { name: np.chapterName ?? np.title }),
      subtitle: np.title,
      icon: s.isPlaying ? 'pause' : 'play',
      run: run.toggle,
    });
    items.push({
      id: 'sleep-minutes',
      title: t('palette.sleepMinutes', { count: s.sleepMinutes }),
      subtitle: t('palette.sleepFades'),
      icon: 'sleep',
      run: run.sleepMinutes,
    });
    if (np.hasChapters) {
      items.push({
        id: 'sleep-chapter',
        title: t('palette.sleepChapter'),
        subtitle: np.chapterName ?? undefined,
        icon: 'sleep',
        run: run.sleepChapter,
      });
    }
    items.push({
      id: 'player',
      title: t('palette.openPlayer'),
      subtitle: np.title,
      icon: 'chevron-up',
      run: run.player,
    });
  }
  if (s.upNext) {
    items.push({
      id: 'up-next',
      title: t('palette.upNext'),
      subtitle: t('palette.upNextHint', { count: s.upNext.count }),
      icon: 'queue',
      run: run.upNext,
    });
  }
  items.push({
    id: 'appearance',
    title: s.dark ? t('palette.light') : t('palette.dark'),
    subtitle: t('settings.appearance.label'),
    icon: s.dark ? 'sun' : 'moon',
    run: run.appearance,
  });
  return items;
}

/** What each Go to item does (the component wires the router). */
export type GoToRuns = {
  tab: (name: TabName) => void;
  you: (section: 'stats' | 'year') => void;
  journal: () => void;
  settings: () => void;
};

/**
 * The palette's Go to: the top bar's destinations (`tabs`, already filtered to what this
 * browser can do) but You, which goes by its sections instead: Your listening, Year in
 * listening, the Journal; then Settings.
 */
export function buildGoToItems(
  tabs: readonly Pick<Destination, 'name' | 'labelKey' | 'icon'>[],
  run: GoToRuns,
  t: TFunction,
): PaletteItem[] {
  return [
    ...tabs
      .filter((d) => d.name !== '(me)')
      .map((d): PaletteItem => ({
        id: `go:${d.name}`,
        title: t(d.labelKey),
        icon: d.icon,
        run: () => run.tab(d.name),
      })),
    { id: 'go:stats', title: t('you.titles.stats'), icon: 'clock', run: () => run.you('stats') },
    { id: 'go:year', title: t('you.titles.year'), icon: 'sparkles', run: () => run.you('year') },
    { id: 'go:journal', title: t('journal.title'), icon: 'history', run: run.journal },
    {
      id: 'go:settings',
      title: t('settings.title'),
      subtitle: t('palette.settingsHint'),
      icon: 'settings',
      run: run.settings,
    },
  ];
}

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
