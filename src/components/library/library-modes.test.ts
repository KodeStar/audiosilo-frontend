import {
  availableLibraryModes,
  libraryModeHref,
  LIBRARY_MODES,
  parseLibraryMode,
  resolveLibraryMode,
} from './library-modes';

describe('library modes', () => {
  it('lists the six sections in sub-nav order', () => {
    expect(LIBRARY_MODES).toEqual([
      'books',
      'authors',
      'series',
      'narrators',
      'collections',
      'folders',
    ]);
  });

  it('reads the mode param, defaulting to books', () => {
    expect(parseLibraryMode('authors')).toBe('authors');
    expect(parseLibraryMode(['folders', 'books'])).toBe('folders');
    expect(parseLibraryMode(undefined)).toBe('books');
    expect(parseLibraryMode('shelves')).toBe('books');
    expect(parseLibraryMode('')).toBe('books');
  });

  it('offers a gated mode only once its capability is known to be on', () => {
    expect(availableLibraryModes({})).toEqual(['books', 'folders']);
    expect(availableLibraryModes({ browsePeople: false, collections: false })).toEqual([
      'books',
      'folders',
    ]);
    expect(availableLibraryModes({ browsePeople: true })).toEqual([
      'books',
      'authors',
      'series',
      'narrators',
      'folders',
    ]);
    expect(availableLibraryModes({ browsePeople: true, collections: true })).toEqual([
      ...LIBRARY_MODES,
    ]);
  });

  it('keeps a requested mode until its server is known to lack it', () => {
    expect(resolveLibraryMode('authors', {})).toBe('authors');
    expect(resolveLibraryMode('authors', { browsePeople: true })).toBe('authors');
    expect(resolveLibraryMode('authors', { browsePeople: false })).toBe('books');
    expect(resolveLibraryMode('collections', { browsePeople: true, collections: false })).toBe(
      'books',
    );
    expect(resolveLibraryMode('folders', { browsePeople: false })).toBe('folders');
  });

  it('links to a mode, leaving the default bare', () => {
    expect(libraryModeHref('books')).toBe('/library');
    expect(libraryModeHref('series')).toEqual({
      pathname: '/library',
      params: { mode: 'series' },
    });
  });
});
