import type { ApiClient } from '@/api/client';
import type { FsEntry, Listing } from '@/api/types';

// next-book's sibling resolution is pure (the client is passed in), so no module mocks are
// needed - only fixture entries + a fake browse() client.
import { findNextSibling, naturalCompare, resolveNextBook } from './next-book';

// --- Fixtures --------------------------------------------------------------

function dir(name: string, path = `Series/${name}`, extra: Partial<FsEntry> = {}): FsEntry {
  return { name, path, is_dir: true, is_audio: false, size: 0, mod_time: 0, ...extra };
}
function bookEntry(name: string, path = `Series/${name}`, extra: Partial<FsEntry> = {}): FsEntry {
  return {
    name,
    path,
    is_dir: false,
    is_audio: true,
    size: 0,
    mod_time: 0,
    is_book: true,
    ...extra,
  };
}
function looseFile(name: string, path = `Series/${name}`, extra: Partial<FsEntry> = {}): FsEntry {
  return { name, path, is_dir: false, is_audio: true, size: 0, mod_time: 0, ...extra };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// --- naturalCompare --------------------------------------------------------

describe('naturalCompare', () => {
  it('orders numerically, not lexicographically', () => {
    expect(naturalCompare('Book 2', 'Book 10')).toBeLessThan(0);
    expect(naturalCompare('Book 10', 'Book 2')).toBeGreaterThan(0);
  });
  it('is case-insensitive', () => {
    expect(naturalCompare('book 3', 'Book 3')).toBe(0);
  });
  it('sorts a mixed list into natural order', () => {
    const names = ['Book 10', 'Book 1', 'Book 2'].sort(naturalCompare);
    expect(names).toEqual(['Book 1', 'Book 2', 'Book 10']);
  });
});

// --- findNextSibling -------------------------------------------------------

describe('findNextSibling', () => {
  it('returns the next book mid-series (numeric-aware)', () => {
    const entries = [dir('Book 1'), dir('Book 2'), dir('Book 10')];
    expect(findNextSibling(entries, 'Series/Book 2')?.name).toBe('Book 10');
  });

  it('returns null for the last book', () => {
    const entries = [dir('Book 1'), dir('Book 2'), dir('Book 10')];
    expect(findNextSibling(entries, 'Series/Book 10')).toBeNull();
  });

  it('falls back to an unindexed sibling folder only when NOTHING is indexed yet (mid-scan)', () => {
    const entries = [dir('Book 1'), dir('Book 2', 'Series/Book 2', { is_book: false })];
    expect(findNextSibling(entries, 'Series/Book 1')?.name).toBe('Book 2');
  });

  it('prefers the next indexed book over a non-book folder sorting between books', () => {
    const entries = [
      bookEntry('Book 1', 'Series/Book 1'),
      dir('Book 1.5 Bonus', 'Series/Book 1.5 Bonus'), // is_dir, is_book falsy -> non-book folder
      bookEntry('Book 2', 'Series/Book 2'),
    ];
    expect(findNextSibling(entries, 'Series/Book 1')?.name).toBe('Book 2');
  });

  it('returns null (not a trailing non-book folder) once the folder has any indexed book', () => {
    const entries = [
      bookEntry('Book 1', 'Series/Book 1'),
      bookEntry('Book 2', 'Series/Book 2'),
      dir('Extras', 'Series/Extras'), // non-book folder sorting after the last real book
    ];
    // Finishing the last real book with only a non-book folder after it = end of series,
    // NOT a jump into the unplayable folder.
    expect(findNextSibling(entries, 'Series/Book 2')).toBeNull();
    // ...and mid-folder it still resolves the real next book, skipping the folder.
    expect(findNextSibling(entries, 'Series/Book 1')?.name).toBe('Book 2');
  });

  it('numbered book folders (SSxx, series_index 0) still order by name', () => {
    // Path-numbered libraries: the server derives series_index 0 for "SSxx" names, so
    // ordering must come from the folder name, not the (useless) index.
    const entries = [
      bookEntry('SS01 - A', 'Series/SS01 - A', { series_index: 0 }),
      bookEntry('SS02 - B', 'Series/SS02 - B', { series_index: 0 }),
      bookEntry('SS03 - C', 'Series/SS03 - C', { series_index: 0 }),
    ];
    expect(findNextSibling(entries, 'Series/SS01 - A')?.name).toBe('SS02 - B');
    expect(findNextSibling(entries, 'Series/SS03 - C')).toBeNull();
  });

  it('ignores loose non-book files and non-audio plain files', () => {
    const entries = [
      bookEntry('Book 1.m4b', 'Series/Book 1.m4b'),
      looseFile('sample.mp3', 'Series/sample.mp3'), // audio but not a book → ignored
      dir('cover.jpg', 'Series/cover.jpg', { is_dir: false, is_audio: false }), // plain file
      bookEntry('Book 2.m4b', 'Series/Book 2.m4b'),
    ];
    expect(findNextSibling(entries, 'Series/Book 1.m4b')?.name).toBe('Book 2.m4b');
  });

  it('excludes the current book itself', () => {
    const entries = [dir('Book 1'), dir('Book 2')];
    // Only the current book plus one earlier sibling → nothing sorts after it.
    expect(findNextSibling([dir('Book 1'), dir('Book 2')], 'Series/Book 2')).toBeNull();
    expect(findNextSibling(entries, 'Series/Book 1')?.name).toBe('Book 2');
  });
});

// --- resolveNextBook -------------------------------------------------------

function fakeClient(pages: Listing[]): ApiClient {
  let call = 0;
  return {
    browse: jest.fn(async () => pages[Math.min(call++, pages.length - 1)]),
  } as unknown as ApiClient;
}

describe('resolveNextBook', () => {
  it('browses the parent folder and returns the next sibling', async () => {
    const client = fakeClient([
      {
        path: 'Series',
        entries: [dir('Book 1'), dir('Book 2')],
        total: 2,
        offset: 0,
      },
    ]);
    const next = await resolveNextBook(client, 5, 'Series/Book 1');
    expect(next?.name).toBe('Book 2');
    expect(client.browse).toHaveBeenCalledWith(5, 'Series', 0, 200);
  });

  it('pages through next_offset to exhaustion before resolving', async () => {
    const client = fakeClient([
      { path: 'Series', entries: [dir('Book 1')], total: 2, offset: 0, next_offset: 1 },
      { path: 'Series', entries: [dir('Book 2')], total: 2, offset: 1 },
    ]);
    const next = await resolveNextBook(client, 5, 'Series/Book 1');
    expect(next?.name).toBe('Book 2');
    expect(client.browse).toHaveBeenCalledTimes(2);
  });

  it('returns null (never throws) when browse fails', async () => {
    const client = {
      browse: jest.fn(async () => {
        throw new Error('unreachable');
      }),
    } as unknown as ApiClient;
    await expect(resolveNextBook(client, 5, 'Series/Book 1')).resolves.toBeNull();
  });
});
