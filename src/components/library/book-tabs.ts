import { type BookTab, firstParam } from '@/lib/paths';

/** The i18n key labelling each tab. Deliberately REUSES the existing section /
 * heading strings rather than minting tab-only duplicates (the bookmarks/history/
 * notes tabs are those sections; the characters tab is the meta block's own
 * heading). Chapters is absent: its label flips between "Chapters" and "Files"
 * depending on the book, so the screen supplies it. */
export const TAB_LABEL_KEY = {
  recaps: 'book.tabs.recaps',
  characters: 'book.meta.characters',
  bookmarks: 'library.bookmarks.title',
  history: 'library.history.title',
  notes: 'library.notes.title',
  series: 'book.tabs.series',
  // `as const` (not a plain `Record<_, string>` annotation) so each value keeps its
  // literal type - `t()` is typed against the locale keys and rejects a bare string.
} as const satisfies Record<Exclude<BookTab, 'chapters'>, string>;

/** What the screen knows about the data behind each optional tab. */
export type BookTabInput = {
  /** The book has a chapter/file list to show. The screen passes true while that
   * request is still IN FLIGHT too: chapters arrive separately, and a row that starts
   * on Bookmarks (firing its GET) only to snap to Chapters a moment later is worse
   * than a briefly-empty Chapters panel. */
  hasList: boolean;
  /** The work has community recaps (false when meta is disabled/unmatched). */
  hasRecaps: boolean;
  /** The work has community characters (false when meta is disabled/unmatched). */
  hasCharacters: boolean;
  /** There is at least one non-empty "more in this series" rail. */
  hasSeries: boolean;
  /** There are earlier books in the series to catch up on. They hang off the Recaps
   * and Characters tabs, so either tab exists once there are any - the catch-up
   * block would otherwise be unreachable on exactly the book that needs it (book N
   * of a series you have not started, with no recaps of its own). */
  hasPreviousBooks: boolean;
  /** Whether the whole-book summary will actually RENDER in the Recaps tab -
   * `summaryIsVisible`'s result (see there). The screen computes this once and
   * passes the same flag to `BookMetaRecapsTab`, so a tab can never exist for a
   * summary its own panel would withhold. */
  summaryVisible: boolean;
};

/**
 * Which tabs exist for a book, in order. Chapters leads (and is the default);
 * the community-metadata tabs are progressive enhancement and simply do not
 * exist when that data is absent, while the user-creatable state (bookmarks /
 * history / notes) is always offered so it can be created from empty.
 *
 * The flags are about the RAW data, not the spoiler-gated subset: a tab whose
 * entries are all still ahead of the listener exists and shows the "hidden to avoid
 * spoilers" row, rather than appearing later and shifting the row of tabs.
 */
export function bookTabs(input: BookTabInput): BookTab[] {
  const tabs: BookTab[] = [];
  if (input.hasList) tabs.push('chapters');
  if (input.hasRecaps || input.summaryVisible || input.hasPreviousBooks) tabs.push('recaps');
  if (input.hasCharacters || input.hasPreviousBooks) tabs.push('characters');
  tabs.push('bookmarks', 'history', 'notes');
  if (input.hasSeries) tabs.push('series');
  return tabs;
}

const BOOK_TABS: readonly BookTab[] = [
  'chapters',
  'recaps',
  'characters',
  'bookmarks',
  'history',
  'notes',
  'series',
];

/** The tab a book link's `?tab=` asks to open on (Expo Router may hand back `string[]`),
 * or null for none or an unknown one. Only an intent: the screen still falls back to the
 * first tab that exists. */
export function parseBookTab(param?: string | string[]): BookTab | null {
  const v = firstParam(param);
  return (BOOK_TABS as readonly string[]).includes(v) ? (v as BookTab) : null;
}
