import { firstParam, type JournalTab } from '@/lib/paths';

/**
 * The Journal's route rules (`/journal?tab=diary|bookmarks|notes`, `journalHref`): pure,
 * so the tab a link opens and the search filter are tested apart from the screen.
 */

const JOURNAL_TABS: readonly string[] = ['diary', 'bookmarks', 'notes'] satisfies JournalTab[];

/** The tab a link asks for; anything else (absent, unknown, repeated) is the Diary. */
export function parseJournalTab(raw: string | string[] | undefined): JournalTab {
  const v = firstParam(raw);
  return JOURNAL_TABS.includes(v) ? (v as JournalTab) : 'diary';
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
