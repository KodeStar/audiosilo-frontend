import type { SourcedProgress } from '@/api/hooks';
import type { Book, NextBook } from '@/api/types';
import { libraryBooksHref } from '@/components/library/books/books-view';
import type { MergedBook } from '@/lib/dedup';

import {
  bookRowTest,
  heroBeside,
  greetingPart,
  nextCandidates,
  nextInSeriesItems,
  pickNowBook,
  playableHere,
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

  // v2.5.1 PLAYER-02: offline, the hero led with a newer book that wasn't downloaded.
  it('leads with the newest book that can play here, else the newest', () => {
    const rows = [
      progress('streamed', '2026-10-05T00:00:00Z'),
      progress('downloaded', '2026-10-04T00:00:00Z'),
    ];
    const onlyDownloaded = (at: { path: string }) => at.path === 'downloaded';
    expect(pickNowBook(null, rows, onlyDownloaded)?.path).toBe('downloaded');
    expect(pickNowBook(null, rows, () => false)?.path).toBe('streamed');
    expect(pickNowBook(null, rows, () => true)?.path).toBe('streamed');
    const loaded = { connectionId: 'b', libraryId: 2, path: 'playing' };
    expect(pickNowBook(loaded, rows, onlyDownloaded)).toBe(loaded);
  });
});

describe('playableHere', () => {
  const at = { connectionId: 'a', libraryId: 1, path: 'p' };
  const no = () => false;
  it('plays online with the server answering, or downloaded', () => {
    expect(playableHere(at, { deviceOnline: true, online: {}, downloaded: no })).toBe(true);
    expect(playableHere(at, { deviceOnline: true, online: { a: false }, downloaded: no })).toBe(
      false,
    );
    expect(playableHere(at, { deviceOnline: false, online: {}, downloaded: no })).toBe(false);
    expect(playableHere(at, { deviceOnline: false, online: {}, downloaded: () => true })).toBe(
      true,
    );
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
  const newest = { at, connectionId: 'a' };
  it('says the place is on this device while saves wait or its server is away', () => {
    expect(syncPill({ online: {}, pending: 2, newest })).toEqual({ kind: 'local' });
    expect(syncPill({ online: { a: false }, pending: 0, newest })).toEqual({ kind: 'local' });
  });
  it('says when it last synced, and nothing with no progress at all', () => {
    expect(syncPill({ online: {}, pending: 0, newest })).toEqual({ kind: 'synced', at });
    expect(syncPill({ online: { a: false }, pending: 0, newest: undefined })).toBeNull();
  });
  // UPGRADE-05: a device that read the list just now says so, not when the save was made.
  it('says when this device last read the progress, when that is later than the save', () => {
    const fetchedAt = Date.parse('2026-10-05T10:24:00Z');
    expect(syncPill({ online: {}, pending: 0, newest, fetchedAt })).toEqual({
      kind: 'synced',
      at: '2026-10-05T10:24:00.000Z',
    });
    // A save made after the read (this device's own, not yet read back) is the later one.
    const earlier = Date.parse('2026-10-05T09:00:00Z');
    expect(syncPill({ online: {}, pending: 0, newest, fetchedAt: earlier })).toEqual({
      kind: 'synced',
      at,
    });
    // Never read (0): the save's time, as before.
    expect(syncPill({ online: {}, pending: 0, newest, fetchedAt: 0 })).toEqual({
      kind: 'synced',
      at,
    });
    // Still on this device while its server is away, however recent the read.
    expect(syncPill({ online: { a: false }, pending: 0, newest, fetchedAt })).toEqual({
      kind: 'local',
    });
  });
  // CONNECT-04: another server being down is not "saved on this device".
  it('still says synced when only a server without the newest progress is down', () => {
    expect(syncPill({ online: { a: true, b: false }, pending: 0, newest })).toEqual({
      kind: 'synced',
      at,
    });
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
    expect(heroBeside(939)).toBe(false);
    // 1024 with the drawer closed.
    expect(heroBeside(960)).toBe(true);
  });
});

describe('bookRowTest', () => {
  const groups = [
    {
      connectionId: 'a',
      libraries: [
        { id: 1, kind: 'books' as const },
        { id: 9, kind: 'podcasts' as const },
      ],
      status: 'ready' as const,
    },
    { connectionId: 'b', libraries: [], status: 'loading' as const },
    { connectionId: 'c', libraries: [], status: 'error' as const },
  ];
  const at = (connectionId: string, libraryId: number) => ({ connectionId, libraryId, path: 'P' });

  it("tells books from episodes by the library's kind", () => {
    const { isBook, pending } = bookRowTest(groups);
    expect(isBook(at('a', 1))).toBe(true);
    expect(isBook(at('a', 9))).toBe(false);
    expect(pending(at('a', 1))).toBe(false);
    expect(pending(at('a', 9))).toBe(false);
  });

  it("holds back a loading server's rows as pending, and reads a failed one as books", () => {
    const { isBook, pending } = bookRowTest(groups);
    expect(isBook(at('b', 1))).toBe(false);
    expect(pending(at('b', 1))).toBe(true);
    expect(isBook(at('c', 1))).toBe(true);
    expect(pending(at('c', 1))).toBe(false);
    // A server not in the list at all is neither.
    expect(isBook(at('z', 1))).toBe(false);
    expect(pending(at('z', 1))).toBe(false);
  });

  it('reads a server whose list waits for the network (offline) as books, never pending (fe#155)', () => {
    const { isBook, pending } = bookRowTest([
      { connectionId: 'b', libraries: [], status: 'loading', paused: true },
    ]);
    expect(isBook(at('b', 1))).toBe(true);
    expect(pending(at('b', 1))).toBe(false);
  });
});
