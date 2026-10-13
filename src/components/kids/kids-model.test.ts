import type { Book, Collection, CollectionDetail, Library, Progress, User } from '@/api/types';
import type { DownloadEntry } from '@/downloads/types';

import {
  kidsAllowsPath,
  kidsCollections,
  kidsCollectionSections,
  kidsConnectionId,
  kidsContinuePaths,
  kidsDownloads,
  kidsGrid,
  kidsLibrary,
  kidsManager,
  kidsOfflineScope,
  kidsOrder,
  kidsSectionBooks,
  kidsShelf,
  kidsShelfMode,
} from './kids-model';

const lib = (id: number, name = `Lib ${id}`): Library => ({
  id,
  name,
  root: `/l${id}`,
  default_view: 'books' as Library['default_view'],
  sort_order: id,
});

const book = (path: string, libraryId = 1): Book =>
  ({ id: 0, library_id: libraryId, rel_path: path, title: path }) as Book;

const progress = (path: string, over: Partial<Progress> = {}): Progress => ({
  library_id: 1,
  path,
  position: 100,
  duration: 1000,
  finished: false,
  playback_speed: 1,
  version: 0,
  device_id: 'd',
  updated_at: '2026-10-01T10:00:00.000Z',
  ...over,
});

describe('kidsConnectionId', () => {
  it("uses the picked library's connection while the profile holds it", () => {
    expect(
      kidsConnectionId(['a.1', 'b.2'], { library: { connectionId: 'b.2', libraryId: 3 } }),
    ).toBe('b.2');
  });

  it("falls back to the profile's first connection", () => {
    expect(
      kidsConnectionId(['a.1', 'b.2'], { library: { connectionId: 'gone.9', libraryId: 3 } }),
    ).toBe('a.1');
    expect(kidsConnectionId(['a.1'], undefined)).toBe('a.1');
    expect(kidsConnectionId(['a.1'], {})).toBe('a.1');
  });

  it('is null for a profile with no connections', () => {
    expect(kidsConnectionId([], { library: { connectionId: 'a.1', libraryId: 1 } })).toBeNull();
  });
});

describe('kidsLibrary', () => {
  const libs = [lib(1), lib(2), lib(3)];

  it('uses the pick when it is still listed on this connection', () => {
    expect(kidsLibrary(libs, 'a.1', { library: { connectionId: 'a.1', libraryId: 2 } })?.id).toBe(
      2,
    );
  });

  it('falls back to the first library when the pick is no longer listed (scopes changed)', () => {
    expect(kidsLibrary(libs, 'a.1', { library: { connectionId: 'a.1', libraryId: 9 } })?.id).toBe(
      1,
    );
  });

  it("ignores a pick on another connection (another server's library 2)", () => {
    expect(kidsLibrary(libs, 'a.1', { library: { connectionId: 'b.2', libraryId: 2 } })?.id).toBe(
      1,
    );
  });

  it('uses the first library without a pick, and null when the account sees none', () => {
    expect(kidsLibrary(libs, 'a.1', undefined)?.id).toBe(1);
    expect(kidsLibrary([], 'a.1', undefined)).toBeNull();
  });
});

describe('kidsContinuePaths', () => {
  it('lists the stories in progress, most recent first', () => {
    const rows = [
      progress('c', { updated_at: '2026-10-01T10:00:00.000Z' }),
      progress('d', { updated_at: '2026-10-03T10:00:00.000Z' }),
    ];
    expect(kidsContinuePaths(rows, 1)).toEqual(['d', 'c']);
  });

  it('leaves out finished and unstarted stories', () => {
    expect(
      kidsContinuePaths([progress('b', { finished: true }), progress('c', { position: 0 })], 1),
    ).toEqual([]);
  });

  it("ignores another library's progress", () => {
    expect(kidsContinuePaths([progress('b', { library_id: 2 })], 1)).toEqual([]);
  });

  it('lists each story once', () => {
    expect(kidsContinuePaths([progress('a'), progress('a')], 1)).toEqual(['a']);
  });
});

describe('kidsShelf', () => {
  const books = [book('a'), book('b'), book('c'), book('d')];

  it('puts the stories in progress first, then the rest in the server order', () => {
    expect(kidsShelf([book('d'), book('c')], books).map((b) => b.rel_path)).toEqual([
      'd',
      'c',
      'a',
      'b',
    ]);
  });

  it('keeps a story in progress first while its page is not loaded yet', () => {
    expect(kidsShelf([book('z')], books).map((b) => b.rel_path)).toEqual(['z', 'a', 'b', 'c', 'd']);
  });

  it('is the listed books alone with nothing in progress', () => {
    expect(kidsShelf([], books)).toEqual(books);
  });
});

describe('kidsDownloads', () => {
  const entry = (
    connectionId: string,
    libraryId: number,
    path: string,
    status: DownloadEntry['status'] = 'downloaded',
    savedAt = '2026-10-01T10:00:00.000Z',
  ): DownloadEntry =>
    ({
      connectionId,
      libraryId,
      path,
      title: path,
      status,
      progress: 1,
      bytes: 0,
      totalBytes: 0,
      manifest: { book: book(path, libraryId), chapters: null, files: [], coverUri: null, savedAt },
    }) as DownloadEntry;

  it("lists the connection's finished downloads in the library, newest first", () => {
    const entries = {
      x: entry('a.1', 1, 'old'),
      y: entry('a.1', 1, 'new', 'downloaded', '2026-10-05T10:00:00.000Z'),
      z: entry('a.1', 2, 'other-library'),
      w: entry('b.2', 1, 'other-server'),
      v: entry('a.1', 1, 'half', 'downloading'),
    };
    expect(kidsDownloads(entries, 'a.1', 1).map((b) => b.rel_path)).toEqual(['new', 'old']);
  });

  it('takes every library of the connection while the library is unknown (offline launch)', () => {
    const entries = { x: entry('a.1', 1, 'one'), y: entry('a.1', 2, 'two') };
    expect(
      kidsDownloads(entries, 'a.1', null)
        .map((b) => b.rel_path)
        .sort(),
    ).toEqual(['one', 'two']);
  });
});

describe('kidsAllowsPath', () => {
  it('allows kids mode and "Who\'s listening?"', () => {
    for (const p of ['/kids', '/profiles']) {
      expect(kidsAllowsPath(p)).toBe(true);
    }
  });

  it('leaves the connect flow to its own gate (D1: connect/_layout.tsx keeps kids mode out)', () => {
    for (const p of ['/connect', '/connect/sign-in', '/connect/scan', '/connect/ready']) {
      expect(kidsAllowsPath(p)).toBe(true);
    }
    expect(kidsAllowsPath('/connectx')).toBe(false);
  });

  it('refuses the tabs, settings, downloads, the player and the rest', () => {
    for (const p of [
      '/',
      '/search',
      '/settings',
      '/downloads',
      '/player',
      '/finished',
      '/year',
      '/book/1',
      '/kidsx',
    ]) {
      expect(kidsAllowsPath(p)).toBe(false);
    }
  });
});

describe('kidsGrid', () => {
  it('fits as many 180 tiles as the width allows wider, never fewer than two', () => {
    expect(kidsGrid(800, 'tablet').columns).toBe(4);
    expect(kidsGrid(1200, 'desktop')).toMatchObject({ columns: 6, tile: 180, columnGap: 24 });
    expect(kidsGrid(300, 'tablet').columns).toBe(2);
  });

  it('keeps two columns on a phone', () => {
    expect(kidsGrid(368, 'phone')).toMatchObject({ columns: 2, tile: 176, columnGap: 16 });
  });

  it('has a tile width before the column is measured', () => {
    expect(kidsGrid(0, 'phone')).toMatchObject({ columns: 2, tile: 150 });
  });
});

describe('kidsOfflineScope', () => {
  it('is the shown library, else the pick on this connection, else none (one library)', () => {
    const kids = { library: { connectionId: 'c', libraryId: 4 } };
    expect(kidsOfflineScope('library', { id: 9 }, 'c', kids)).toBe(9);
    expect(kidsOfflineScope('library', null, 'c', kids)).toBe(4);
    expect(kidsOfflineScope('library', null, 'd', kids)).toBeNull();
    expect(kidsOfflineScope('library', null, 'c', undefined)).toBeNull();
  });

  it("is every story on the account for a member's collections, or a shelf not known yet", () => {
    const kids = { library: { connectionId: 'c', libraryId: 4 } };
    expect(kidsOfflineScope('collections', { id: 9 }, 'c', kids)).toBeNull();
    expect(kidsOfflineScope('unknown', null, 'c', kids)).toBeNull();
  });
});

describe("a household member's shelf (Phase 8b-1)", () => {
  const ADAM = { id: 1, username: 'adam' };
  const coll = (id: number, owner = ADAM, owned = false): Collection => ({
    id,
    name: `C${id}`,
    description: '',
    owner,
    owned,
    item_count: 0,
    preview: [],
    created_at: '',
    updated_at: '',
  });
  const detail = (c: Collection, books: (Book | null)[]): CollectionDetail => ({
    collection: c,
    items: books.map((b, i) => ({
      library_id: b?.library_id ?? 1,
      path: b?.rel_path ?? `gone-${i}`,
      added_at: '',
      ...(b ? { book: b } : {}),
    })),
  });

  it("kidsCollections: only those the account's owner shares, in the list's order", () => {
    const list = [coll(1), coll(2, { id: 3, username: 'bob' }), coll(3, ADAM), coll(4, ADAM)];
    expect(kidsCollections(list, { managed_by: ADAM }).map((c) => c.id)).toEqual([1, 3, 4]);
    // Its own collections never (even were the owner's id its own).
    expect(kidsCollections([coll(5, ADAM, true)], { managed_by: ADAM })).toEqual([]);
    // Nobody manages it (an ordinary account, a Phase 8 kid, an older server): none.
    expect(kidsCollections(list, { managed_by: null })).toEqual([]);
    expect(kidsCollections(list, {})).toEqual([]);
    expect(kidsCollections(list, undefined)).toEqual([]);
  });

  it('kidsOrder: in progress first (newest first, across libraries), then in order, once each', () => {
    const books = [book('a', 1), book('b', 2), book('c', 1), book('a', 2), book('a', 1)];
    const rows = [
      progress('c', { updated_at: '2026-10-01T09:00:00.000Z' }),
      progress('a', { library_id: 2, updated_at: '2026-10-01T11:00:00.000Z' }),
      progress('b', { library_id: 2, finished: true }),
      progress('zzz'),
    ];
    expect(kidsOrder(books, rows).map((b) => `${b.library_id}/${b.rel_path}`)).toEqual([
      '2/a',
      '1/c',
      '1/a',
      '2/b',
    ]);
  });

  it('kidsCollectionSections: titled runs, stories in progress first; empty left out', () => {
    const one = kidsCollectionSections(
      [coll(1), coll(2)],
      [detail(coll(1), [book('a'), null, book('b')]), detail(coll(2), [])],
      [progress('b')],
    );
    expect(one.map((s) => [s.key, s.title, s.books.map((b) => b.rel_path)])).toEqual([
      ['collection-1', 'C1', ['b', 'a']],
    ]);
    const two = kidsCollectionSections(
      [coll(1), coll(2), coll(3)],
      [detail(coll(1), [book('a')]), undefined, detail(coll(3), [book('c'), book('a')])],
      [],
    );
    expect(two.map((s) => [s.title, s.books.map((b) => b.rel_path)])).toEqual([
      ['C1', ['a']],
      ['C3', ['c', 'a']],
    ]);
    expect(kidsSectionBooks(two).map((b) => b.rel_path)).toEqual(['a', 'c']);
    expect(kidsCollectionSections([coll(1)], [detail(coll(1), [null])], [])).toEqual([]);
  });

  it('kidsShelfMode: the shared collections, else one library, unknown until both answers', () => {
    const member = { managed_by: ADAM };
    const shared = [coll(1)];
    const others = [coll(2, { id: 3, username: 'bob' })];
    expect(kidsShelfMode(member, true, shared)).toBe('collections');
    expect(kidsShelfMode(member, true, others)).toBe('library');
    expect(kidsShelfMode(member, true, [])).toBe('library');
    // A server without collections, or an account nobody manages: one library at once.
    expect(kidsShelfMode(member, false, undefined)).toBe('library');
    expect(kidsShelfMode({ managed_by: null }, undefined, undefined)).toBe('library');
    expect(kidsShelfMode(undefined, true, shared)).toBe('library');
    // Not known yet: the capability, or the list.
    expect(kidsShelfMode(member, undefined, shared)).toBe('unknown');
    expect(kidsShelfMode(member, true, undefined)).toBe('unknown');
  });
});

describe('kidsManager (8b-1)', () => {
  const user = (id: number, owner?: string) =>
    ({
      id,
      username: `u${id}`,
      managed_by: owner ? { id: 1, username: owner } : null,
    }) as unknown as User;
  const connections = [
    { id: 'a.1', user: user(1) },
    { id: 'a.12', user: user(12, 'adam') },
  ];
  const people = { connections, profiles: [] };

  it("names who manages the account kids mode shows, by the kids connection's user", () => {
    expect(kidsManager({ connectionIds: ['a.12'], kids: { bedtime: '19:30' } }, people)).toBe(
      'adam',
    );
    // The picked library's connection decides which account that is.
    expect(
      kidsManager(
        {
          connectionIds: ['a.12', 'a.1'],
          kids: { bedtime: '19:30', library: { connectionId: 'a.1', libraryId: 2 } },
        },
        people,
      ),
    ).toBeNull();
    expect(kidsManager({ connectionIds: [] }, people)).toBeNull();
  });

  it("with no pick, takes the first of the profile's connections in the session's order, as kids mode does", () => {
    // The profile lists a.12 first (a sign-in again after a server reset keeps its slot),
    // the session a.1: kids mode shows a.1, so it is a.1's account that counts.
    expect(
      kidsManager({ connectionIds: ['a.12', 'a.1'], kids: { bedtime: '19:30' } }, people),
    ).toBeNull();
    expect(
      kidsManager(
        { connectionIds: ['a.12', 'a.1'], kids: { bedtime: '19:30' } },
        { connections: [connections[1], connections[0]], profiles: [] },
      ),
    ).toBe('adam');
  });

  it("names the owner as this device's profile holding their own sign-in, when there is one", () => {
    // a.1 is adam's own sign-in on server a (managed_by.id 1): his profile is "Dad" here.
    expect(
      kidsManager(
        { connectionIds: ['a.12'], kids: { bedtime: '19:30' } },
        {
          connections,
          profiles: [
            { name: 'Dad', connectionIds: ['a.1'] },
            { name: 'Ellie', connectionIds: ['a.12'] },
          ],
        },
      ),
    ).toBe('Dad');
  });
});
