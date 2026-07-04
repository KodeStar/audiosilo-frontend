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

describe('libraryHref', () => {
  it('returns the bare, connection-scoped library route at the root', () => {
    expect(libraryHref('c1', 7)).toBe('/s/c1/library/7');
    expect(libraryHref('c1', 7, '')).toBe('/s/c1/library/7');
  });

  it('appends encoded path segments for a sub-path', () => {
    expect(libraryHref('c1', 7, 'Author/Book Title')).toBe('/s/c1/library/7/Author/Book%20Title');
  });
});

describe('bookHref', () => {
  it('builds an encoded, connection-scoped book route', () => {
    expect(bookHref('c1', 3, 'Author/Book Title')).toBe('/s/c1/book/3/Author/Book%20Title');
  });
});

describe('accountHref', () => {
  it('builds the connection-scoped account route', () => {
    expect(accountHref('c1')).toBe('/s/c1/account');
  });
});
