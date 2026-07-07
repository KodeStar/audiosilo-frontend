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

  it('counts an unindexed sibling folder (is_dir true, is_book false)', () => {
    const entries = [dir('Book 1'), dir('Book 2', 'Series/Book 2', { is_book: false })];
    expect(findNextSibling(entries, 'Series/Book 1')?.name).toBe('Book 2');
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
