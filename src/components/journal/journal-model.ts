import type { MyBookmark, MyNote } from '@/api/types';
import { foldAccents } from '@/lib/names';
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

/** Text as the search compares it: accents off, lower case ("Émile" reads "emile"). */
const fold = (s: string) => foldAccents(s).toLocaleLowerCase();

/** The words of a search, folded once (none for a blank one, which matches everything). */
export function searchWords(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** Whether every one of `words` occurs in `hay` (folded, `annotationHaystack`). */
export const matchesWords = (words: readonly string[], hay: string): boolean =>
  words.every((w) => hay.includes(w));

const haystacks = new WeakMap<object, string>();

/** What the search looks at in a bookmark or note (its book's title and author, the note
 * or body), folded once per row: the rows keep their identity while unchanged. */
export function annotationHaystack(row: MyBookmark | MyNote): string {
  let hay = haystacks.get(row);
  if (hay === undefined) {
    const text = 'body' in row ? row.body : row.note;
    hay = fold([row.book?.title, row.book?.author, text].filter(Boolean).join('\n'));
    haystacks.set(row, hay);
  }
  return hay;
}
