import { bookTabs, TAB_LABEL_KEY } from './book-tabs';

const none = {
  hasList: false,
  hasRecaps: false,
  hasCharacters: false,
  hasSeries: false,
  hasPreviousBooks: false,
  summaryVisible: false,
};

describe('bookTabs', () => {
  it('always offers the user-creatable tabs, in order', () => {
    expect(bookTabs(none)).toEqual(['bookmarks', 'history', 'notes']);
  });

  it('leads with chapters when the book has a list', () => {
    expect(bookTabs({ ...none, hasList: true })[0]).toBe('chapters');
  });

  it('still leads with chapters while the chapter request is in flight', () => {
    // The screen passes `hasList || chaptersLoading` for exactly this: with no data
    // yet, `hasList` alone opens the row on Bookmarks - firing that GET - and then
    // snaps everything over to Chapters when the chapters land.
    const noDataYet = false;
    const chaptersLoading = true;
    expect(bookTabs({ ...none, hasList: noDataYet })[0]).toBe('bookmarks');
    expect(bookTabs({ ...none, hasList: noDataYet || chaptersLoading })[0]).toBe('chapters');
  });

  it('adds each metadata tab only when its data is non-empty', () => {
    expect(bookTabs({ ...none, hasRecaps: true })).toContain('recaps');
    expect(bookTabs({ ...none, hasCharacters: true })).toContain('characters');
    expect(bookTabs({ ...none, hasSeries: true })).toContain('series');
    expect(bookTabs(none)).not.toContain('recaps');
    expect(bookTabs(none)).not.toContain('characters');
    expect(bookTabs(none)).not.toContain('series');
  });

  it('offers Recaps for a visible whole-book summary even with no position-keyed recaps', () => {
    expect(bookTabs({ ...none, summaryVisible: true })).toContain('recaps');
    expect(bookTabs({ ...none, summaryVisible: true })).not.toContain('characters');
  });

  it('withholds the tab for a summary whose panel would render nothing', () => {
    // An ending-only summary on an unfinished book: `summaryVisible` is false, so
    // no Recaps tab exists to open onto an empty panel.
    expect(bookTabs(none)).not.toContain('recaps');
  });

  it('offers both catch-up tabs when there are earlier books to read up on', () => {
    const tabs = bookTabs({ ...none, hasPreviousBooks: true });
    expect(tabs).toContain('recaps');
    expect(tabs).toContain('characters');
  });

  it('orders a fully-populated book chapters → meta → user state → series', () => {
    expect(
      bookTabs({
        ...none,
        hasList: true,
        hasRecaps: true,
        hasCharacters: true,
        hasSeries: true,
      }),
    ).toEqual(['chapters', 'recaps', 'characters', 'bookmarks', 'history', 'notes', 'series']);
  });
});

describe('TAB_LABEL_KEY', () => {
  it('has a key for every tab the screen can show except chapters', () => {
    const shown = bookTabs({
      ...none,
      hasList: true,
      hasRecaps: true,
      hasCharacters: true,
      hasSeries: true,
    });
    for (const tab of shown) {
      if (tab === 'chapters') continue;
      expect(TAB_LABEL_KEY[tab]).toBeTruthy();
    }
  });

  it('reuses the existing section strings rather than tab-only duplicates', () => {
    expect(TAB_LABEL_KEY.bookmarks).toBe('library.bookmarks.title');
    expect(TAB_LABEL_KEY.history).toBe('library.history.title');
    expect(TAB_LABEL_KEY.notes).toBe('library.notes.title');
    expect(TAB_LABEL_KEY.characters).toBe('book.meta.characters');
  });
});
