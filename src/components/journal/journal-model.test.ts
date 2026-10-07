import type { MyBookmark, MyNote } from '@/api/types';

import { annotationHaystack, matchesWords, parseJournalTab, searchWords } from './journal-model';

describe('parseJournalTab', () => {
  it('opens the tab a link names', () => {
    expect(parseJournalTab('bookmarks')).toBe('bookmarks');
    expect(parseJournalTab('notes')).toBe('notes');
    expect(parseJournalTab(['notes', 'diary'])).toBe('notes');
  });
  it('falls back to the Diary for anything else', () => {
    expect(parseJournalTab(undefined)).toBe('diary');
    expect(parseJournalTab('stats')).toBe('diary');
    expect(parseJournalTab('')).toBe('diary');
  });
});

describe('the search', () => {
  const bookmark = (note: string, title?: string): MyBookmark => ({
    id: 1,
    library_id: 1,
    path: 'p',
    position: 0,
    note,
    label: '',
    created_at: '',
    ...(title ? { book: { title, author: 'Brandon Sanderson' } as MyBookmark['book'] } : {}),
  });
  const matches = (query: string, row: MyBookmark | MyNote) =>
    matchesWords(searchWords(query), annotationHaystack(row));

  it('matches every word anywhere in the book and the text, ignoring case', () => {
    const row = bookmark('Bridge Four starts', 'The Way of Kings');
    expect(matches('kings BRIDGE', row)).toBe(true);
    expect(matches('sanderson', row)).toBe(true);
    expect(matches('kings storm', row)).toBe(false);
  });
  it('ignores accents both ways', () => {
    expect(matches('Emile', bookmark('Émile at the door'))).toBe(true);
    expect(matches('émile', bookmark('Emile at the door'))).toBe(true);
  });
  it("searches a note's body", () => {
    const note = { ...bookmark(''), body: 'Szeth in the palace', updated_at: '' } as MyNote;
    expect(matches('palace', note)).toBe(true);
  });
  it('matches everything on an empty query and skips missing texts', () => {
    expect(searchWords('  ')).toEqual([]);
    expect(matches('  ', bookmark(''))).toBe(true);
    expect(matches('a', bookmark(''))).toBe(false);
  });
});
