import {
  availableLibraryModes,
  libraryModeHref,
  LIBRARY_MODES,
  parseLibraryMode,
  resolveLibraryMode,
} from './library-modes';

describe('library modes', () => {
  it('lists the sections in sub-nav order', () => {
    expect(LIBRARY_MODES).toEqual([
      'shows',
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
    expect(availableLibraryModes({ browsePeople: true, collections: true })).toEqual(
      LIBRARY_MODES.filter((m) => m !== 'shows'),
    );
  });

  // Bridge Phase 2d-1.
  it('offers a podcast library its shows and the folders only', () => {
    expect(availableLibraryModes({ browsePeople: true, collections: true }, true)).toEqual([
      'shows',
      'folders',
    ]);
    // Not known yet: no Shows offered, book modes as before.
    expect(availableLibraryModes({ browsePeople: true }, undefined)).toEqual([
      'books',
      'authors',
      'series',
      'narrators',
      'folders',
    ]);
  });

  it('maps a book mode to Shows on a podcast library, and Shows to Books elsewhere', () => {
    expect(resolveLibraryMode('books', {}, true)).toBe('shows');
    expect(resolveLibraryMode('authors', { browsePeople: true }, true)).toBe('shows');
    expect(resolveLibraryMode('folders', {}, true)).toBe('folders');
    expect(resolveLibraryMode('shows', {}, true)).toBe('shows');
    expect(resolveLibraryMode('shows', {}, false)).toBe('books');
    // A link to Shows stands while the library is not known yet.
    expect(resolveLibraryMode('shows', {}, undefined)).toBe('shows');
    expect(parseLibraryMode('shows')).toBe('shows');
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
