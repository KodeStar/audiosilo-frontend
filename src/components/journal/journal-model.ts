import type { Href } from 'expo-router';

/**
 * The Journal's route rules (`/journal?tab=diary|bookmarks|notes`): pure, so the tab a
 * link opens and the search filter are tested apart from the screen.
 */

export type JournalTab = 'diary' | 'bookmarks' | 'notes';

export const JOURNAL_TABS: readonly JournalTab[] = ['diary', 'bookmarks', 'notes'];

/** The tab a link asks for; anything else (absent, unknown, repeated) is the Diary. */
export function parseJournalTab(raw: string | string[] | undefined): JournalTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return JOURNAL_TABS.includes(v as JournalTab) ? (v as JournalTab) : 'diary';
}

/** The Journal, on `tab` when given (the Diary is the plain `/journal`). */
export function journalHref(tab?: JournalTab): Href {
  return tab && tab !== 'diary' ? { pathname: '/journal', params: { tab } } : '/journal';
}

const fold = (s: string) => s.toLocaleLowerCase();

/** Whether every word of `query` occurs in one of `texts` (case-insensitive). An empty
 * query matches everything. */
export function matchesQuery(query: string, ...texts: (string | undefined)[]): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(texts.filter(Boolean).join('\n'));
  return words.every((w) => hay.includes(w));
}
