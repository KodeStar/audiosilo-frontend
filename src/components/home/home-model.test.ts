import type { SourcedProgress } from '@/api/hooks';
import type { Book, NextBook } from '@/api/types';
import { libraryBooksHref } from '@/components/library/books/books-view';
import type { MergedBook } from '@/lib/dedup';

import {
  heroBeside,
  greetingPart,
  nextCandidates,
  nextInSeriesItems,
  pickNowBook,
  smartShelfHref,
  smartShelves,
  splitProgress,
  syncPill,
} from './home-model';

const progress = (
  path: string,
  updated: string,
  extra: Partial<SourcedProgress> = {},
): SourcedProgress => ({
  connectionId: 'a',
  connectionName: 'Home',
  library_id: 1,
  path,
  position: 100,
  duration: 1000,
  finished: false,
  playback_speed: 1,
  version: 0,
  device_id: 'd',
  updated_at: updated,
  ...extra,
});

const book = (path: string, extra: Partial<Book> = {}): Book =>
  ({ library_id: 1, rel_path: path, title: path, author: 'A', duration: 3600, ...extra }) as Book;
const merged = (path: string, extra: Partial<MergedBook> = {}): MergedBook =>
  ({ ...book(path), connectionId: 'a', connectionName: 'Home', also: [], ...extra }) as MergedBook;

describe('splitProgress', () => {
  it('splits started and finished books, newest first', () => {
    const { inProgress, finished } = splitProgress([
      progress('old', '2026-10-01T00:00:00Z'),
      progress('done', '2026-10-03T00:00:00Z', { finished: true }),
      progress('new', '2026-10-04T00:00:00Z'),
      progress('untouched', '2026-10-05T00:00:00Z', { position: 0 }),
    ]);
    expect(inProgress.map((p) => p.path)).toEqual(['new', 'old']);
    expect(finished.map((p) => p.path)).toEqual(['done']);
  });
});

describe('pickNowBook', () => {
  const ip = [progress('recent', '2026-10-04T00:00:00Z')];
  it('leads with the loaded book, else the most recent in progress', () => {
    const loaded = { connectionId: 'b', libraryId: 2, path: 'playing' };
    expect(pickNowBook(loaded, ip)).toBe(loaded);
    expect(pickNowBook(null, ip)).toEqual({ connectionId: 'a', libraryId: 1, path: 'recent' });
    expect(pickNowBook(null, [])).toBeNull();
  });
});

describe('greetingPart', () => {
  it('follows the local hour', () => {
    expect(greetingPart(6)).toBe('morning');
    expect(greetingPart(12)).toBe('afternoon');
    expect(greetingPart(18)).toBe('evening');
  });
});

describe('syncPill', () => {
  const at = '2026-10-05T10:00:00Z';
  it('says the place is on this device while saves wait or a server is away', () => {
    expect(syncPill({ offline: false, pending: 2, lastSaved: at })).toEqual({ kind: 'local' });
    expect(syncPill({ offline: true, pending: 0, lastSaved: at })).toEqual({ kind: 'local' });
  });
  it('says when it last synced, and nothing with no progress at all', () => {
    expect(syncPill({ offline: false, pending: 0, lastSaved: at })).toEqual({
      kind: 'synced',
      at,
    });
    expect(syncPill({ offline: true, pending: 0, lastSaved: undefined })).toBeNull();
  });
});

describe('nextCandidates', () => {
  it('looks past the Now book, then other books in progress, then finished ones', () => {
    const now = { connectionId: 'a', libraryId: 1, path: 'p1' };
    const ip = ['p1', 'p2', 'p3', 'p4', 'p5'].map((p) => progress(p, '2026-10-04T00:00:00Z'));
    const done = ['f1', 'f2', 'f3'].map((p) =>
      progress(p, '2026-10-01T00:00:00Z', { finished: true, finished_at: '2026-09-13T00:00:00Z' }),
    );
    const out = nextCandidates(now, ip, done);
    expect(out.map((c) => c.path)).toEqual(['p1', 'p2', 'p3', 'p4', 'f1', 'f2']);
    expect(out[0].reason).toEqual({ kind: 'current' });
    expect(out[1].reason).toEqual({
      kind: 'progress',
      of: { connectionId: 'a', libraryId: 1, path: 'p2' },
      percent: 10,
    });
    expect(out[4].reason).toMatchObject({ kind: 'finished', at: '2026-09-13T00:00:00Z' });
  });
});

describe('nextInSeriesItems', () => {
  const cand = (path: string) => ({
    connectionId: 'a',
    libraryId: 1,
    path,
    reason: { kind: 'current' as const },
  });
  const owned = (path: string): NextBook => ({
    source: 'series',
    next: { library_id: 3, path },
    book: book(path, { library_id: 3 }),
  });
  const work = { id: 'w4', title: 'Book Four', position: '4', authors: [], web_url: 'u' };

  it('turns owned next books into tiles in their own library', () => {
    const items = nextInSeriesItems([{ candidate: cand('one'), answer: owned('two') }], new Set());
    expect(items).toEqual([
      expect.objectContaining({ kind: 'book', key: 'a:3:two', libraryId: 3, path: 'two' }),
    ]);
  });
  it('shows an unplaced community work as a ghost, never one this server placed', () => {
    const items = nextInSeriesItems(
      [
        { candidate: cand('one'), answer: { source: 'none', work } },
        {
          candidate: cand('x'),
          answer: {
            source: 'none',
            work: { ...work, id: 'w5', local: { library_id: 1, path: 'y' } },
          },
        },
      ],
      new Set(),
    );
    expect(items).toEqual([expect.objectContaining({ kind: 'ghost', key: 'a:work:w4' })]);
  });
  it('skips books already on Home and shows a shared next book once', () => {
    const items = nextInSeriesItems(
      [
        { candidate: cand('one'), answer: owned('two') },
        { candidate: cand('other'), answer: owned('two') },
        { candidate: cand('three'), answer: owned('started') },
        { candidate: cand('four'), answer: undefined },
        { candidate: cand('five'), answer: { source: 'none' } },
      ],
      new Set(['a:3:started']),
    );
    expect(items.map((i) => i.key)).toEqual(['a:3:two']);
  });
});

describe('smartShelves', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const ip = [progress('p1', '2026-10-04T00:00:00Z'), progress('p2', '2026-10-03T00:00:00Z')];
  const recent = [
    merged('short', { duration: 2 * 3600, added_at: '2026-10-04T00:00:00Z' }),
    merged('long', { duration: 20 * 3600, added_at: '2026-09-01T00:00:00Z' }),
    merged('maya', {
      duration: 9 * 3600,
      added_at: '2026-10-02T00:00:00Z',
      connectionId: 'b',
    }),
  ];

  it('offers the shelves that have books on them', () => {
    const shelves = smartShelves({ inProgress: ip, recent, now });
    expect(shelves.map((s) => s.id)).toEqual(['progress', 'short', 'added']);
    expect(shelves[0]).toMatchObject({ id: 'progress', count: 2 });
    expect(shelves[1].covers.map((c) => c.path)).toEqual(['short']);
    expect(shelves[2]).toMatchObject({ id: 'added', count: 2, servers: 2 });
  });
  it('adds the narrator shelf only with books of theirs', () => {
    const narrator = {
      name: 'Kate Reading',
      books: 4,
      listened: 7200,
      connectionId: 'a',
      libraryId: 1,
      sample: [book('k1'), book('k2')],
    };
    const shelves = smartShelves({ inProgress: ip, recent: [], narrator, now });
    expect(shelves.map((s) => s.id)).toEqual(['progress', 'narrator']);
    expect(
      smartShelves({ inProgress: ip, recent: [], narrator: { ...narrator, sample: [] }, now }),
    ).toEqual([]);
  });
  it('shows no section for a single shelf', () => {
    expect(smartShelves({ inProgress: ip, recent: [], now })).toEqual([]);
  });
});

describe('links', () => {
  it('opens the Library books mode with the shelf’s filter', () => {
    expect(libraryBooksHref({ status: 'progress' })).toEqual({
      pathname: '/library',
      params: { mode: 'books', status: 'progress' },
    });
    expect(smartShelfHref({ id: 'short', covers: [] })).toEqual({
      pathname: '/library',
      params: { mode: 'books', len: 'short' },
    });
    expect(smartShelfHref({ id: 'added', count: 1, servers: 1, covers: [] })).toEqual({
      pathname: '/library',
      params: { mode: 'books', sort: 'recent' },
    });
  });
});

describe('heroBeside', () => {
  it('puts This week beside the Now card only when both fit the column', () => {
    expect(heroBeside(0)).toBe(true);
    expect(heroBeside(1376)).toBe(true);
    // 1024 less the drawer and the page padding.
    expect(heroBeside(600)).toBe(false);
    expect(heroBeside(919)).toBe(false);
    expect(heroBeside(920)).toBe(true);
  });
});
