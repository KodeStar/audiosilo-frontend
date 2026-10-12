import type { Book, Library, Progress } from '@/api/types';
import type { DownloadEntry } from '@/downloads/types';

import {
  kidsAllowsPath,
  kidsConnectionId,
  kidsContinuePaths,
  kidsDownloads,
  kidsGrid,
  kidsLibrary,
  kidsOfflineLibraryId,
  kidsShelf,
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
  it('allows kids mode, "Who\'s listening?" and the connect flow', () => {
    for (const p of ['/kids', '/profiles', '/connect', '/connect/sign-in']) {
      expect(kidsAllowsPath(p)).toBe(true);
    }
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

describe('kidsOfflineLibraryId', () => {
  it('is the shown library, else the pick on this connection, else none', () => {
    const kids = { library: { connectionId: 'c', libraryId: 4 } };
    expect(kidsOfflineLibraryId({ id: 9 }, 'c', kids)).toBe(9);
    expect(kidsOfflineLibraryId(null, 'c', kids)).toBe(4);
    expect(kidsOfflineLibraryId(null, 'd', kids)).toBeNull();
    expect(kidsOfflineLibraryId(null, 'c', undefined)).toBeNull();
  });
});
