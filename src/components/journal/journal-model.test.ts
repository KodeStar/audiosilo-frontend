import { journalHref, matchesQuery, parseJournalTab } from './journal-model';

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

describe('journalHref', () => {
  it('is the plain route for the Diary and carries any other tab', () => {
    expect(journalHref()).toBe('/journal');
    expect(journalHref('diary')).toBe('/journal');
    expect(journalHref('notes')).toEqual({ pathname: '/journal', params: { tab: 'notes' } });
  });
});

describe('matchesQuery', () => {
  it('matches every word anywhere in the texts, ignoring case', () => {
    expect(matchesQuery('kings BRIDGE', 'The Way of Kings', 'Bridge Four starts')).toBe(true);
    expect(matchesQuery('kings storm', 'The Way of Kings', 'Bridge Four')).toBe(false);
  });
  it('matches everything on an empty query and skips missing texts', () => {
    expect(matchesQuery('  ', undefined)).toBe(true);
    expect(matchesQuery('a', undefined, '')).toBe(false);
  });
});
