import {
  accountHref,
  authorHref,
  bookHref,
  collectionHref,
  finishedHref,
  libraryHref,
  narratorHref,
  parentPath,
  parseCollectionParams,
  parsePersonParams,
  parseSeriesParams,
  pathLeaf,
  playerHref,
  segmentsToPath,
  seriesHref,
} from '@/lib/paths';

describe('segmentsToPath', () => {
  it('returns empty string for undefined', () => {
    expect(segmentsToPath(undefined)).toBe('');
  });

  it('passes a single string through', () => {
    expect(segmentsToPath('Author/Book')).toBe('Author/Book');
  });

  it('joins a string[] with slashes', () => {
    expect(segmentsToPath(['Author', 'Book', 'part1.mp3'])).toBe('Author/Book/part1.mp3');
  });
});

describe('pathLeaf', () => {
  it('returns empty string at the library root', () => {
    expect(pathLeaf('')).toBe('');
  });

  it('returns the only segment for a single-segment path', () => {
    expect(pathLeaf('Author')).toBe('Author');
  });

  it('returns the last segment for a nested path', () => {
    expect(pathLeaf('Author/Series/Book')).toBe('Book');
  });

  it('ignores a trailing slash', () => {
    expect(pathLeaf('Author/Book/')).toBe('Book');
  });
});

describe('parentPath', () => {
  it("returns '' at the library root", () => {
    expect(parentPath('')).toBe('');
  });

  it("returns '' for a single segment", () => {
    expect(parentPath('Author')).toBe('');
  });

  it('drops the last segment for a nested path', () => {
    expect(parentPath('Author/Series/Book')).toBe('Author/Series');
  });

  it('ignores a trailing slash', () => {
    expect(parentPath('Author/Book/')).toBe('Author');
  });
});

// The hrefs are FLAT routes (OBJECT form: route pattern + params) with the connection
// and library-relative path both as QUERY params. An imperative `router.push` can't
// resolve a tap into a route nested under a dynamic layout segment (it lands on the
// scope group's first child, `account`); flat routes + a query param push correctly.
// Expo Router builds the URL from the pattern + params.
describe('libraryHref', () => {
  it('omits path at the library root', () => {
    const expected = {
      pathname: '/library/[libraryId]',
      params: { libraryId: '7', connection: 'c1' },
    };
    expect(libraryHref('c1', 7)).toEqual(expected);
    expect(libraryHref('c1', 7, '')).toEqual(expected);
  });

  it('carries a sub-path as the `path` query param', () => {
    expect(libraryHref('c1', 7, 'Author/Book Title')).toEqual({
      pathname: '/library/[libraryId]',
      params: { libraryId: '7', connection: 'c1', path: 'Author/Book Title' },
    });
  });
});

describe('bookHref', () => {
  it('carries connection + path as query params on the flat book route', () => {
    expect(bookHref('c1', 3, 'Author/Book Title')).toEqual({
      pathname: '/book/[libraryId]',
      params: { libraryId: '3', connection: 'c1', path: 'Author/Book Title' },
    });
  });
  it('opens on a tab when asked', () => {
    expect(bookHref('c1', 3, 'B', 'characters')).toEqual({
      pathname: '/book/[libraryId]',
      params: { libraryId: '3', connection: 'c1', path: 'B', tab: 'characters' },
    });
  });
});

describe('accountHref', () => {
  it('builds the flat account route with the connection query param', () => {
    expect(accountHref('c1')).toEqual({ pathname: '/account', params: { connection: 'c1' } });
  });
});

describe('playerHref', () => {
  it('opens the player on a book, at its saved place by default', () => {
    expect(playerHref('c1', 3, 'A/B')).toEqual({
      pathname: '/player',
      params: { connection: 'c1', libraryId: '3', path: 'A/B' },
    });
  });

  it('carries a place: whole seconds (never below 0), or a file by index', () => {
    expect(playerHref('c1', 3, 'A/B', { position: 62_810.6 })).toMatchObject({
      params: { position: '62811' },
    });
    expect(playerHref('c1', 3, 'A/B', { position: -0.2 })).toMatchObject({
      params: { position: '0' },
    });
    expect(playerHref('c1', 3, 'A/B', { track: 2 })).toEqual({
      pathname: '/player',
      params: { connection: 'c1', libraryId: '3', path: 'A/B', track: '2' },
    });
  });
});

describe('finishedHref', () => {
  it('carries connection + path and defaults auto to 0 (early open)', () => {
    expect(finishedHref('c1', 3, 'Author/Book Title')).toEqual({
      pathname: '/finished',
      params: { connection: 'c1', libraryId: '3', path: 'Author/Book Title', auto: '0' },
    });
  });

  it('encodes an auto (natural-end) arrival as 1', () => {
    expect(finishedHref('c1', 3, 'Author/Book Title', true)).toEqual({
      pathname: '/finished',
      params: { connection: 'c1', libraryId: '3', path: 'Author/Book Title', auto: '1' },
    });
  });
});

describe('browse detail hrefs', () => {
  it('builds a local series link', () => {
    expect(seriesHref('c1', 3, { name: 'The Stormlight Archive' })).toEqual({
      pathname: '/series',
      params: { connection: 'c1', library: '3', name: 'The Stormlight Archive' },
    });
  });

  it('builds a community series link, with or without a local name', () => {
    expect(seriesHref('c1', 3, { work: 'w-42' })).toEqual({
      pathname: '/series',
      params: { connection: 'c1', library: '3', work: 'w-42' },
    });
    expect(seriesHref('c1', 3, { name: 'Dune', work: 'w-1' })).toMatchObject({
      params: { name: 'Dune', work: 'w-1' },
    });
  });

  it('builds author, narrator and collection links', () => {
    expect(authorHref('c', 1, 'Kramer & Reading')).toEqual({
      pathname: '/author',
      params: { connection: 'c', library: '1', name: 'Kramer & Reading' },
    });
    expect(narratorHref('c', 2, 'Kate Reading')).toEqual({
      pathname: '/narrator',
      params: { connection: 'c', library: '2', name: 'Kate Reading' },
    });
    expect(collectionHref('c', 7)).toEqual({
      pathname: '/collection',
      params: { connection: 'c', id: '7' },
    });
  });
});

describe('browse detail params', () => {
  it('round-trips a series link, keeping the name exactly', () => {
    expect(
      parseSeriesParams({ connection: 'c', library: '3', name: ' Dune ', work: ['w', 'x'] }),
    ).toEqual({ connectionId: 'c', libraryId: 3, name: ' Dune ', work: 'w' });
    expect(parseSeriesParams({ connection: 'c', library: '3', work: 'w' })).toEqual({
      connectionId: 'c',
      libraryId: 3,
      work: 'w',
    });
  });

  it('rejects a series link without a library or without a series', () => {
    expect(parseSeriesParams({ connection: 'c', name: 'Dune' })).toBeNull();
    expect(parseSeriesParams({ connection: 'c', library: 'x', name: 'Dune' })).toBeNull();
    expect(parseSeriesParams({ connection: 'c', library: '0', name: 'Dune' })).toBeNull();
    expect(parseSeriesParams({ connection: 'c', library: '3', name: '  ' })).toBeNull();
  });

  it('parses a person link', () => {
    expect(parsePersonParams({ connection: 'c', library: '2', name: 'Kate Reading' })).toEqual({
      connectionId: 'c',
      libraryId: 2,
      name: 'Kate Reading',
    });
    expect(parsePersonParams({ connection: 'c', library: '2' })).toBeNull();
    expect(parsePersonParams({ library: '-1', name: 'x' })).toBeNull();
  });

  it('parses a collection link', () => {
    expect(parseCollectionParams({ connection: 'c', id: '7' })).toEqual({
      connectionId: 'c',
      id: 7,
    });
    expect(parseCollectionParams({ connection: 'c', id: '7a' })).toBeNull();
    expect(parseCollectionParams({ connection: 'c' })).toBeNull();
  });
});
