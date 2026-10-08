import type { SourcedProgress } from '@/api/hooks';
import type { Book, Chapter, Progress } from '@/api/types';
import type { DownloadEntry, DownloadManifest } from '@/downloads/types';
import i18n from '@/i18n';

import {
  buildCarSnapshot,
  CAR_TAB_LIMITS,
  carItem,
  carItemId,
  carLabels,
  continueRefs,
  downloadedEntries,
  parseCarItemId,
  playSpec,
  type CarBook,
  type CarItemContext,
} from './car-model';

const t = i18n.t.bind(i18n);

function makeBook(p: Partial<Book> = {}): Book {
  return {
    id: 1,
    library_id: 2,
    rel_path: 'A/Book.m4b',
    is_folder: false,
    title: 'A Book',
    author: 'Ann Author',
    series: '',
    series_index: 0,
    narrator: 'Ned Narrator',
    duration: 7200,
    format: 'm4b',
    size: 0,
    ...p,
  };
}

function makeProgress(p: Partial<Progress> = {}): Progress {
  return {
    library_id: 2,
    path: 'A/Book.m4b',
    position: 0,
    duration: 7200,
    finished: false,
    playback_speed: 1,
    version: 0,
    device_id: 'dev',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...p,
  };
}

function row(cid: string, p: Partial<Progress>): SourcedProgress {
  return { ...makeProgress(p), connectionId: cid, connectionName: cid };
}

const ctx = (over: Partial<CarItemContext> = {}): CarItemContext => ({
  t,
  defaultRate: 1,
  live: null,
  isDownloaded: () => false,
  artworkFor: () => null,
  playFor: () => undefined,
  ...over,
});

const ref = { connectionId: 'c1', libraryId: 2, path: 'A/Book.m4b' };

describe('carItemId / parseCarItemId', () => {
  it.each([
    ['plain', { connectionId: 'c1', libraryId: 2, path: 'A/Book.m4b' }],
    ['colons', { connectionId: 'srv:1', libraryId: 10, path: 'Series: One/Part: 2.mp3' }],
    ['percent signs', { connectionId: 'c%1', libraryId: 3, path: '100% Done/%20.m4b' }],
    ['spaces', { connectionId: 'c 1', libraryId: 0, path: ' Leading and trailing /a b.m4b ' }],
    ['unicode', { connectionId: 'сервер', libraryId: 7, path: 'Ünïcödé/日本語の本 🎧.m4b' }],
  ])('round-trips a path with %s', (_name, r) => {
    const id = carItemId(r);
    expect(id.startsWith('book:')).toBe(true);
    // Exactly three parts: every ':' inside a part is encoded.
    expect(id.slice(5).split(':')).toHaveLength(3);
    expect(parseCarItemId(id)).toEqual(r);
  });

  it.each([
    ['another scheme', 'item:c1:2:a'],
    ['too few parts', 'book:c1:2'],
    ['too many parts', 'book:c1:2:a:b'],
    ['a non-numeric library', 'book:c1:x:a'],
    ['a negative library', 'book:c1:-1:a'],
    ['an empty path', 'book:c1:2:'],
    ['an empty connection', 'book::2:a'],
    ['a malformed escape', 'book:c1:2:%E0%A4%A'],
    ['nothing', ''],
  ])('rejects %s', (_name, id) => {
    expect(parseCarItemId(id)).toBeNull();
  });
});

describe('carLabels', () => {
  it('has every label, in the app language', () => {
    const labels = carLabels(t);
    expect(labels).toEqual({
      continue: 'Continue listening',
      upNext: 'Up next',
      downloads: 'Downloads',
      library: 'Library',
      chapters: 'Chapters',
      bookmark: 'Bookmark',
      bookmarkSaved: 'Bookmark saved',
      empty: 'Nothing here yet',
      signedOut: 'Connect a server in AudioSilo to listen in the car',
      unavailable: "This book can't play right now",
    });
  });
});

describe('continueRefs', () => {
  it("is Home's rule: books in progress across servers, newest first", () => {
    const rows = [
      row('c1', { path: 'old', position: 10, updated_at: '2026-01-01T00:00:00.000Z' }),
      row('c2', { path: 'new', position: 10, updated_at: '2026-03-01T00:00:00.000Z' }),
      row('c1', { path: 'done', position: 7200, finished: true, updated_at: '2026-04-01' }),
      row('c1', { path: 'unstarted', position: 0, updated_at: '2026-05-01T00:00:00.000Z' }),
    ];
    expect(continueRefs(rows, null).map((r) => r.ref)).toEqual([
      { connectionId: 'c2', libraryId: 2, path: 'new' },
      { connectionId: 'c1', libraryId: 2, path: 'old' },
    ]);
  });

  it('leads with the loaded book, also before its first save reaches the list', () => {
    const rows = [row('c1', { path: 'other', position: 5, updated_at: '2026-03-01' })];
    const loaded = { connectionId: 'c2', libraryId: 4, path: 'playing' };
    const out = continueRefs(rows, loaded);
    expect(out.map((r) => r.ref.path)).toEqual(['playing', 'other']);
    expect(out[0].progress).toBeNull();
  });

  it('keeps the loaded book once, with its row, when it is in the list', () => {
    const rows = [
      row('c1', { path: 'newer', position: 5, updated_at: '2026-03-01' }),
      row('c1', { path: 'playing', position: 5, updated_at: '2026-02-01' }),
    ];
    const out = continueRefs(rows, { connectionId: 'c1', libraryId: 2, path: 'playing' });
    expect(out.map((r) => r.ref.path)).toEqual(['playing', 'newer']);
    expect(out[0].progress?.path).toBe('playing');
  });

  it('keeps the same path on two servers apart', () => {
    const rows = [
      row('c1', { path: 'same', position: 5, updated_at: '2026-03-01' }),
      row('c2', { path: 'same', position: 5, updated_at: '2026-02-01' }),
    ];
    expect(continueRefs(rows, null)).toHaveLength(2);
  });

  it('stops at the limit', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row('c1', {
        path: `b${i}`,
        position: 5,
        updated_at: `2026-01-${String(i + 1).padStart(2, '0')}`,
      }),
    );
    expect(continueRefs(rows, null)).toHaveLength(CAR_TAB_LIMITS.continue);
  });
});

function makeManifest(p: Partial<DownloadManifest> = {}): DownloadManifest {
  return {
    book: makeBook(),
    chapters: null,
    files: [{ relPath: 'A/Book.m4b', localUri: 'file:///docs/downloads/c1/2/book/0.m4b' }],
    coverUri: 'file:///docs/downloads/c1/2/book/cover.jpg',
    savedAt: '2026-01-01T00:00:00.000Z',
    ...p,
  };
}

function makeEntry(p: Partial<DownloadEntry> = {}): DownloadEntry {
  return {
    connectionId: 'c1',
    libraryId: 2,
    path: 'A/Book.m4b',
    title: 'A Book',
    status: 'downloaded',
    progress: 1,
    bytes: 0,
    totalBytes: 0,
    manifest: makeManifest(),
    ...p,
  };
}

describe('downloadedEntries', () => {
  it('lists only downloaded books, newest download first', () => {
    const entries = {
      a: makeEntry({ path: 'a', manifest: makeManifest({ savedAt: '2026-01-01' }) }),
      b: makeEntry({ path: 'b', manifest: makeManifest({ savedAt: '2026-03-01' }) }),
      c: makeEntry({ path: 'c', status: 'downloading' }),
      d: makeEntry({ path: 'd', status: 'error' }),
    };
    expect(downloadedEntries(entries).map((e) => e.path)).toEqual(['b', 'a']);
  });
});

describe('carItem', () => {
  it('names the author and the time left at the book’s own speed once started', () => {
    const item = carItem(
      { ref, book: makeBook(), progress: makeProgress({ position: 3600, playback_speed: 1.5 }) },
      ctx(),
    );
    expect(item).toEqual({
      id: carItemId(ref),
      title: 'A Book',
      subtitle: 'Ann Author · 40m left at 1.5×',
      progress: 0.5,
      finished: false,
      downloaded: false,
      artwork: null,
    });
  });

  it('says only the author before the book is started (no progress)', () => {
    const item = carItem({ ref, book: makeBook(), progress: null }, ctx());
    expect(item.subtitle).toBe('Ann Author');
    expect(item.progress).toBeNull();
  });

  it('uses the default speed for a book without a saved one, and the narrator without an author', () => {
    const item = carItem(
      {
        ref,
        book: makeBook({ author: '' }),
        progress: makeProgress({ position: 3600, playback_speed: 0 }),
      },
      ctx({ defaultRate: 2 }),
    );
    expect(item.subtitle).toBe('Ned Narrator · 30m left at 2×');
  });

  it('reads a finished book as done, without time left', () => {
    const item = carItem(
      { ref, book: makeBook(), progress: makeProgress({ position: 7200, finished: true }) },
      ctx(),
    );
    expect(item).toMatchObject({ progress: 1, finished: true, subtitle: 'Ann Author' });
  });

  it('uses the live place and the player’s speed for the loaded book', () => {
    const item = carItem(
      { ref, book: makeBook(), progress: makeProgress({ position: 60 }) },
      ctx({ live: { ref, position: 5400, total: 7200, rate: 1 } }),
    );
    expect(item.progress).toBe(0.75);
    expect(item.subtitle).toBe('Ann Author · 30m left');
  });

  it('titles a book with no item from its path', () => {
    const item = carItem({ ref, book: null, progress: null }, ctx());
    expect(item.title).toBe('Book.m4b');
    expect(item.subtitle).toBe('');
  });

  it('carries the artwork, and a play spec only for a downloaded book', () => {
    const spec = {
      book: ref,
      tracks: [],
      chapters: [],
      startIndex: 0,
      positionInTrack: 0,
      rate: 1,
    };
    const base = { artworkFor: () => 'file:///art.jpg', playFor: () => spec };
    const streamed = carItem({ ref, book: makeBook(), progress: null }, ctx(base));
    expect(streamed.artwork).toBe('file:///art.jpg');
    expect(streamed.downloaded).toBe(false);
    expect(streamed.play).toBeUndefined();
    const downloaded = carItem(
      { ref, book: makeBook(), progress: null },
      ctx({ ...base, isDownloaded: () => true }),
    );
    expect(downloaded.downloaded).toBe(true);
    expect(downloaded.play).toBe(spec);
  });
});

function chapter(p: Partial<Chapter>): Chapter {
  return {
    index: 0,
    title: '',
    file_index: 0,
    file_path: 'A/1.mp3',
    start: 0,
    end: 100,
    book_offset: 0,
    ...p,
  };
}

describe('playSpec', () => {
  const twoFiles = makeManifest({
    book: makeBook({ rel_path: 'A', duration: 200 }),
    chapters: {
      library_id: 2,
      path: 'A',
      duration: 200,
      is_folder: true,
      files: [
        { rel_path: 'A/1.mp3', seq: 0, duration: 100, format: 'mp3', size: 1 },
        { rel_path: 'A/2.mp3', seq: 1, duration: 100, format: 'mp3', size: 1 },
      ],
      chapters: [
        chapter({ index: 0, title: 'One', file_path: 'A/1.mp3', start: 0, end: 100 }),
        chapter({
          index: 1,
          title: 'Two',
          file_index: 1,
          file_path: 'A/2.mp3',
          start: 0,
          end: 100,
        }),
      ],
    },
    files: [
      { relPath: 'A/1.mp3', localUri: 'file:///d/1.mp3' },
      { relPath: 'A/2.mp3', localUri: 'file:///d/2.mp3' },
    ],
  });
  const bookRef = { connectionId: 'c1', libraryId: 2, path: 'A' };

  it('resumes at the saved place, at the saved speed, from local files with no headers', () => {
    const spec = playSpec(
      bookRef,
      twoFiles,
      {
        kind: 'progress',
        progress: makeProgress({ path: 'A', position: 130, playback_speed: 1.25 }),
      },
      1,
      1800,
    );
    expect(spec).toMatchObject({
      book: bookRef,
      startIndex: 1,
      positionInTrack: 30,
      rate: 1.25,
    });
    expect(spec!.tracks.map((tr) => tr.url)).toEqual(['file:///d/1.mp3', 'file:///d/2.mp3']);
    expect(spec!.tracks.every((tr) => tr.headers === undefined)).toBe(true);
    expect(spec!.tracks[0].artwork).toBe(twoFiles.coverUri);
    expect(spec!.chapters).toEqual([
      { fileIndex: 0, startInFile: 0, endInFile: 0, title: 'One' },
      { fileIndex: 1, startInFile: 0, endInFile: 0, title: 'Two' },
    ]);
  });

  it('starts a finished book again at 0 (playBook’s rule)', () => {
    const spec = playSpec(
      bookRef,
      twoFiles,
      { kind: 'progress', progress: makeProgress({ path: 'A', position: 200, finished: true }) },
      1,
      1800,
    );
    expect(spec).toMatchObject({ startIndex: 0, positionInTrack: 0 });
  });

  it('starts a new book at 0 at the default speed, clamped to the product range', () => {
    expect(playSpec(bookRef, twoFiles, { kind: 'empty' }, 3, 1800)).toMatchObject({
      startIndex: 0,
      positionInTrack: 0,
      rate: 2,
    });
    expect(playSpec(bookRef, twoFiles, { kind: 'failed' }, 1, 1800)?.rate).toBe(1);
  });

  it('gives none when a file has no local copy', () => {
    const partial = { ...twoFiles, files: twoFiles.files.slice(0, 1) };
    expect(playSpec(bookRef, partial, { kind: 'empty' }, 1, 1800)).toBeUndefined();
  });
});

describe('buildCarSnapshot', () => {
  const labels = carLabels(t);
  const book = (path: string): CarBook => ({
    ref: { connectionId: 'c1', libraryId: 2, path },
    book: makeBook({ rel_path: path, title: path }),
    progress: null,
  });

  it('lays out the four tabs in order with their titles', () => {
    const snap = buildCarSnapshot(
      {
        generatedAt: '2026-10-08T00:00:00.000Z',
        labels,
        signedIn: true,
        books: { continue: [book('a')], upnext: [book('b')], downloads: [], library: [book('c')] },
      },
      ctx(),
    );
    expect(snap.version).toBe(1);
    expect(snap.signedIn).toBe(true);
    expect(snap.labels).toBe(labels);
    expect(snap.tabs.map((tab) => [tab.id, tab.title, tab.items.map((i) => i.title)])).toEqual([
      ['continue', 'Continue listening', ['a']],
      ['upnext', 'Up next', ['b']],
      ['downloads', 'Downloads', []],
      ['library', 'Library', ['c']],
    ]);
  });

  it('leaves Up next out where the server keeps no queue', () => {
    const snap = buildCarSnapshot(
      {
        generatedAt: 'x',
        labels,
        signedIn: true,
        books: { continue: [], upnext: null, downloads: [], library: [] },
      },
      ctx(),
    );
    expect(snap.tabs.map((tab) => tab.id)).toEqual(['continue', 'downloads', 'library']);
  });

  it('dedupes a tab by book and trims it to its limit', () => {
    const many = Array.from({ length: 60 }, (_, i) => book(`b${i}`));
    const snap = buildCarSnapshot(
      {
        generatedAt: 'x',
        labels,
        signedIn: true,
        books: { continue: [book('a'), book('a')], upnext: [], downloads: many, library: many },
      },
      ctx(),
    );
    expect(snap.tabs[0].items).toHaveLength(1);
    expect(snap.tabs[2].items).toHaveLength(CAR_TAB_LIMITS.downloads);
    expect(snap.tabs[3].items).toHaveLength(CAR_TAB_LIMITS.library);
  });

  it('lists nothing when signed out', () => {
    const snap = buildCarSnapshot(
      {
        generatedAt: 'x',
        labels,
        signedIn: false,
        books: { continue: [book('a')], upnext: [], downloads: [book('b')], library: [] },
      },
      ctx(),
    );
    expect(snap.signedIn).toBe(false);
    expect(snap.tabs.every((tab) => tab.items.length === 0)).toBe(true);
  });

  it('serializes without a session token or a server URL', () => {
    const snap = buildCarSnapshot(
      {
        generatedAt: 'x',
        labels,
        signedIn: true,
        books: { continue: [book('a')], upnext: null, downloads: [], library: [] },
      },
      ctx({ artworkFor: () => 'file:///docs/car-artwork/abc.jpg' }),
    );
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/token|https?:/);
  });
});
