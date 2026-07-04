import {
  accountHref,
  bookHref,
  encodePathSegments,
  libraryHref,
  parentPath,
  pathLeaf,
  segmentsToPath,
} from '@/lib/paths';

describe('encodePathSegments', () => {
  it('encodes each segment with encodeURIComponent', () => {
    expect(encodePathSegments('Author/Book Title')).toBe('Author/Book%20Title');
  });

  it('escapes #, space and % within a segment', () => {
    expect(encodePathSegments('a#b/c d/e%f')).toBe('a%23b/c%20d/e%25f');
  });

  it('drops empty segments (leading/trailing/double slashes)', () => {
    expect(encodePathSegments('/a//b/')).toBe('a/b');
    expect(encodePathSegments('')).toBe('');
    expect(encodePathSegments('///')).toBe('');
  });
});

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
});

describe('accountHref', () => {
  it('builds the flat account route with the connection query param', () => {
    expect(accountHref('c1')).toEqual({ pathname: '/account', params: { connection: 'c1' } });
  });
});
