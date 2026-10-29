import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';

import type { ApiClient } from '@/api/client';
import type { Book, ChaptersResponse } from '@/api/types';
import type { DownloadEntry, DownloadManifest } from '@/downloads/types';

// The store resolves its file storage from './engine' (Metro picks the per-platform
// impl) and reads `engine.supported` at import time. Mock it with a fully-featured
// fake so we drive relocateEntry / hydrate / the download queue without a device.
// Every method now leads with `connectionId` (per-server scoping); `localUri` echoes
// its inputs so a test can read back exactly what filename the store derived for each
// file (the only way to observe the private `fileName`/`relocateEntry` helpers). The
// mock object must live inside the factory (babel hoists jest.mock above the imports,
// so an outer const isn't initialised yet when the store first requires it); we read
// it back via require() below.
jest.mock('@/downloads/engine', () => ({
  engine: {
    supported: true,
    localUri: jest.fn(
      (connectionId: string, libraryId: number, path: string, name: string) =>
        `live:${connectionId}:${libraryId}:${path}:${name}`,
    ),
    fileExists: jest.fn(async (_uri: string) => true),
    removeBook: jest.fn(async (_cid: string, _libraryId: number, _path: string) => {}),
    downloadFile: jest.fn(),
    storageEstimate: jest.fn(async () => null),
    verify: undefined,
    probe: undefined,
    totalBytesUsed: jest.fn(async () => 0),
    // iOS's rename of an old `<i>.mka` (set per test; the web engine has none).
    renameFile: undefined,
    // The offline companion's payload file (its IO goes through offline-meta, mocked
    // below); only its presence gates keeping metadata.
    writeText: jest.fn(async () => true),
  },
}));

// The offline companion (offline-meta.ts has its own tests): the store's part is WHEN it
// keeps, restores and fills in a book's metadata, observed through these fakes.
const mockCapture = jest.fn(async (_e: DownloadEntry): Promise<unknown> => null);
const mockWriteMeta = jest.fn(async (_e: DownloadEntry, _p: unknown) => true);
const mockReadMeta = jest.fn(async (_e: DownloadEntry): Promise<unknown> => null);
const mockRemoveMeta = jest.fn(async (_e: DownloadEntry) => {});
const mockSeedMeta = jest.fn();
const mockSeedServer = jest.fn();
const mockSeedQuery = jest.fn();
const mockHasMetadata = jest.fn(async (_cid: string) => true);
const mockCanMatch = jest.fn((_e: DownloadEntry) => true);
const mockReadSnapshots = jest.fn(async (): Promise<Record<string, unknown>> => ({}));
const mockSaveSnapshot = jest.fn(async (..._a: unknown[]) => {});
const mockForgetSnapshot = jest.fn(async (_cid: string) => {});
const mockCurrentSnapshot = jest.fn((_cid: string): unknown => undefined);
const mockRelease = jest.fn();
jest.mock('@/downloads/offline-meta', () => ({
  canMatch: (e: DownloadEntry) => mockCanMatch(e),
  captureOfflineMeta: (e: DownloadEntry) => mockCapture(e),
  writeOfflineMeta: (e: DownloadEntry, p: unknown) => mockWriteMeta(e, p),
  readOfflineMeta: (e: DownloadEntry) => mockReadMeta(e),
  removeOfflineMeta: (e: DownloadEntry) => mockRemoveMeta(e),
  seedOfflineMeta: (...a: unknown[]) => mockSeedMeta(...a),
  seedServerSnapshot: (...a: unknown[]) => mockSeedServer(...a),
  seedQuery: (...a: unknown[]) => mockSeedQuery(...a),
  serverHasMetadata: (cid: string) => mockHasMetadata(cid),
  whenSessionReady: async () => {},
  readServerSnapshots: () => mockReadSnapshots(),
  saveServerSnapshot: (...a: unknown[]) => mockSaveSnapshot(...a),
  forgetServerSnapshot: (cid: string) => mockForgetSnapshot(cid),
  currentServerSnapshot: (cid: string) => mockCurrentSnapshot(cid),
  releaseOfflineBook: (...a: unknown[]) => mockRelease(...a),
}));

// The app reader's cached EPUB (ebook-file.native.ts has its own tests): a download takes
// it instead of fetching the book again.
const mockCachedEbook = jest.fn(async (_ref: unknown): Promise<string | null> => null);
jest.mock('@/reader/ebook-file', () => ({
  cachedEbookUri: (ref: unknown) => mockCachedEbook(ref),
}));

// A download's read-along map (readalong-file.ts has its own tests): the store's part is
// WHEN it fetches, keeps and drops one. The pure rules are the real ones.
const mockFetchReadalong = jest.fn(
  async (..._a: unknown[]): Promise<{ uri: string; generatedAt: string } | undefined> => undefined,
);
const mockRemoveReadalong = jest.fn(async (_ref: unknown) => {});
jest.mock('@/downloads/readalong-file', () => ({
  ...jest.requireActual('@/downloads/readalong-file'),
  fetchReadalongFile: (...a: unknown[]) => mockFetchReadalong(...a),
  removeReadalongFile: (ref: unknown) => mockRemoveReadalong(ref),
  readReadalongFile: jest.fn(async () => null),
}));

// The launch's restore waits for the JS thread to be idle: here, the next turn.
(globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback = (cb) =>
  setTimeout(cb, 0);

// The connection-clients seam: runOne resolves each entry's own client via resolveClient.
jest.mock('@/api/connection-clients', () => ({
  resolveClient: jest.fn(() => null),
}));

// The store registers an onConnectionRemoved purge at import time.
jest.mock('@/stores/session', () => ({
  onConnectionRemoved: jest.fn(() => () => {}),
}));

// Avoid pulling the real React Query client / hooks graph into the unit test.
// `getQueryData` answers the web transcode guard's cached `/server` read.
const mockGetQueryData = jest.fn((..._a: unknown[]): unknown => undefined);
// The full item/chapters lookup of a list-shape book on web (by query key).
const mockFetchQuery = jest.fn((_o: { queryKey: unknown[] }): Promise<unknown> =>
  Promise.reject(new Error('not mocked')),
);
// The query cache's listeners (`startChapterRefresh` subscribes one).
const mockCacheListeners = new Set<(event: unknown) => void>();
jest.mock('@/api/provider', () => ({
  queryClient: {
    getQueryCache: () => ({
      subscribe: (l: (event: unknown) => void) => {
        mockCacheListeners.add(l);
        return () => mockCacheListeners.delete(l);
      },
    }),
    setQueryData: jest.fn(),
    invalidateQueries: jest.fn(),
    getQueryData: (...a: unknown[]) => mockGetQueryData(...a),
    fetchQuery: (o: { queryKey: unknown[] }) => mockFetchQuery(o),
  },
}));
jest.mock('@/api/hooks', () => ({
  useSavedProgress: () => undefined,
  cachedCapability: (cid: string, flag: string) => {
    const info = mockGetQueryData(['server', cid]) as
      { capabilities: Record<string, boolean> } | undefined;
    return info ? !!info.capabilities[flag] : undefined;
  },
  qk: {
    item: (cid: string, lib: number, path: string) => ['item', cid, lib, path],
    chapters: (cid: string, lib: number, path: string) => ['chapters', cid, lib, path],
    server: (cid: string) => ['server', cid],
  },
  itemQuery: (cid: string, _c: unknown, lib: number, path: string) => ({
    queryKey: ['item', cid, lib, path],
  }),
  chaptersQuery: (cid: string, _c: unknown, lib: number, path: string) => ({
    queryKey: ['chapters', cid, lib, path],
  }),
  // The real helper's reading of `qk.chapters` (hooks.test.ts covers it).
  chaptersKeyParts: ([kind, cid, libraryId, path]: unknown[]) =>
    kind === 'chapters' ? { cid, libraryId, path } : null,
}));

// Imported after the mocks so the store binds to the fakes above.
/* eslint-disable import/first */
import { resolveClient } from '@/api/connection-clients';
import { engine } from '@/downloads/engine';
import { bookFileSpecs } from '@/playback/book-queue';
import {
  downloadedCountFor,
  downloadedEntryOf,
  downloadKey,
  adoptStartedChapters,
  isDeclined,
  refreshedChapters,
  reviveEntry,
  startChapterRefresh,
  startReadalongRefresh,
  useDownloadedCoverUri,
  useDownloadedEbook,
  useDownloadedReadalong,
  useDownloadEntry,
  useDownloads,
  useIsDownloaded,
} from '@/downloads/store';
import { onConnectionRemoved } from '@/stores/session';
/* eslint-enable import/first */

// Typed handle to the mocked engine's jest.fn members.
const mockEngine = engine as unknown as {
  supported: boolean;
  localUri: jest.Mock | undefined;
  fileExists: jest.Mock;
  removeBook: jest.Mock;
  downloadFile: jest.Mock;
  storageEstimate: jest.Mock;
  verify: ((uri: string) => Promise<boolean>) | undefined;
  probe: (() => Promise<boolean>) | undefined;
  renameFile: jest.Mock | undefined;
  copyFile: jest.Mock | undefined;
};

const mockResolveClient = resolveClient as jest.Mock;

// The purge callback the store registered at import (captured before clearAllMocks).
const removalCleanup = (onConnectionRemoved as jest.Mock).mock.calls[0]?.[0] as (
  id: string,
) => Promise<void>;

// The default localUri implementation (restored between tests after any override).
const defaultLocalUri = (connectionId: string, libraryId: number, path: string, name: string) =>
  `live:${connectionId}:${libraryId}:${path}:${name}`;

const KEY = 'audiosilo.downloads';

// The platform a test starts on (tests that pick one get it back in beforeEach).
const defaultOS = Platform.OS;

function makeBook(p: Partial<Book> = {}): Book {
  return {
    id: 1,
    library_id: 2,
    rel_path: 'A/Book',
    is_folder: true,
    title: 'A Book',
    author: 'Author',
    series: '',
    series_index: 0,
    narrator: '',
    duration: 0,
    format: 'mp3',
    size: 0,
    ...p,
  };
}

/** A book of three 100-byte files, `A/Book/00.mp3` to `02.mp3`. */
function threeFileBook(): Book {
  return makeBook({
    files: [0, 1, 2].map((i) => ({
      rel_path: `A/Book/0${i}.mp3`,
      seq: i,
      duration: 60,
      format: 'mp3',
      size: 100,
    })),
  });
}

function downloadedEntry(p: Partial<DownloadEntry> = {}): DownloadEntry {
  const book = makeBook();
  const manifest: DownloadManifest = {
    book,
    chapters: null,
    files: [
      { relPath: 'A/Book/01.mp3', localUri: 'stale:01' },
      { relPath: 'A/Book/02.mp3', localUri: 'stale:02' },
    ],
    coverUri: 'stale:cover',
    savedAt: '2026-01-01T00:00:00Z',
  };
  return {
    connectionId: 'c1',
    libraryId: 2,
    path: 'A/Book',
    title: 'A Book',
    status: 'downloaded',
    progress: 1,
    bytes: 0,
    totalBytes: 0,
    manifest,
    ...p,
  };
}

async function seed(registry: Record<string, DownloadEntry>) {
  await AsyncStorage.setItem(KEY, JSON.stringify(registry));
}

async function readPersisted(): Promise<Record<string, DownloadEntry>> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as Record<string, DownloadEntry>) : {};
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  // Reset to the default (well-behaved) engine behaviour between tests. A prior test
  // may have replaced localUri with undefined (the web no-op case), so re-install it.
  mockEngine.supported = true;
  mockEngine.localUri = jest.fn(defaultLocalUri);
  mockEngine.fileExists.mockResolvedValue(true);
  mockEngine.removeBook.mockResolvedValue(undefined);
  // clearAllMocks keeps implementations: a test's downloadFile must not reach the next.
  mockEngine.downloadFile.mockReset();
  mockEngine.verify = undefined;
  mockEngine.probe = undefined;
  mockEngine.renameFile = undefined;
  mockEngine.copyFile = undefined;
  mockCachedEbook.mockReset().mockResolvedValue(null);
  Platform.OS = defaultOS;
  // Reset the connection-clients seam so a per-test override can't leak.
  mockResolveClient.mockReset().mockReturnValue(null);
  mockCapture.mockReset().mockResolvedValue(null);
  mockWriteMeta.mockReset().mockResolvedValue(true);
  mockReadMeta.mockReset().mockResolvedValue(null);
  mockHasMetadata.mockReset().mockResolvedValue(true);
  mockCanMatch.mockReset().mockReturnValue(true);
  mockFetchReadalong.mockReset().mockResolvedValue(undefined);
  mockGetQueryData.mockReset().mockReturnValue(undefined);
  // Clear any entries leaked from a prior test (the store is a module singleton).
  useDownloads.setState({ entries: {}, hydrated: false });
});

describe('downloadKey', () => {
  it('composes (connectionId, libraryId, path)', () => {
    expect(downloadKey('c1', 2, 'A/Book')).toBe('c1:2:A/Book');
  });

  it('scopes the same (libraryId, path) separately per connection', () => {
    expect(downloadKey('c1', 2, 'A/Book')).not.toBe(downloadKey('c2', 2, 'A/Book'));
  });
});

describe('downloadedCountFor', () => {
  it('counts only fully-downloaded entries belonging to the connection', () => {
    const entries = {
      [downloadKey('c1', 2, 'A')]: downloadedEntry({ path: 'A' }),
      [downloadKey('c1', 2, 'B')]: downloadedEntry({ path: 'B', status: 'downloading' }),
      [downloadKey('c2', 2, 'A')]: downloadedEntry({ connectionId: 'c2' }),
    };
    expect(downloadedCountFor(entries, 'c1')).toBe(1);
    expect(downloadedCountFor(entries, 'c2')).toBe(1);
    expect(downloadedCountFor(entries, 'c3')).toBe(0);
  });
});

describe('downloadedEntryOf', () => {
  it("answers a book's entry only once it is fully downloaded, on its own connection", () => {
    const a = downloadedEntry({ path: 'A' });
    useDownloads.setState({
      entries: {
        [downloadKey('c1', 2, 'A')]: a,
        [downloadKey('c1', 2, 'B')]: downloadedEntry({ path: 'B', status: 'downloading' }),
      },
    });
    expect(downloadedEntryOf({ connectionId: 'c1', libraryId: 2, path: 'A' })).toBe(a);
    expect(downloadedEntryOf({ connectionId: 'c1', libraryId: 2, path: 'B' })).toBeUndefined();
    expect(downloadedEntryOf({ connectionId: 'c2', libraryId: 2, path: 'A' })).toBeUndefined();
    useDownloads.setState({ entries: {} });
  });
});

describe('useDownloadedEbook', () => {
  it("answers a finished download's EPUB, never an unfinished one's or an empty uri", async () => {
    const withEbook = (p: Partial<DownloadEntry>, ebookUri: string) => {
      const e = downloadedEntry(p);
      return { ...e, manifest: { ...e.manifest, ebookUri } };
    };
    useDownloads.setState({
      entries: {
        [downloadKey('c1', 2, 'A')]: withEbook({ path: 'A' }, 'file:///d/A/book.epub'),
        [downloadKey('c1', 2, 'B')]: withEbook({ path: 'B', status: 'downloading' }, 'x'),
        [downloadKey('c1', 2, 'C')]: withEbook({ path: 'C' }, ''),
        [downloadKey('c1', 2, 'D')]: downloadedEntry({ path: 'D' }),
      },
    });
    const uri = async (path: string) =>
      (await renderHook(() => useDownloadedEbook('c1', 2, path))).result.current;
    expect(await uri('A')).toBe('file:///d/A/book.epub');
    for (const path of ['B', 'C', 'D', 'E']) expect(await uri(path)).toBeUndefined();
    useDownloads.setState({ entries: {} });
  });
});

describe('the narrow download selectors', () => {
  const key = downloadKey('c1', 2, 'A/Book');
  const patch = (p: Partial<DownloadEntry>) =>
    act(async () => {
      const s = useDownloads.getState();
      useDownloads.setState({ entries: { ...s.entries, [key]: { ...s.entries[key], ...p } } });
    });

  afterEach(() => useDownloads.setState({ entries: {} }));

  it('re-render nothing on progress ticks, and update when the download finishes', async () => {
    useDownloads.setState({
      entries: { [key]: downloadedEntry({ status: 'downloading', progress: 0.1, bytes: 10 }) },
    });
    const renders = { status: 0, cover: 0, entry: 0 };
    const status = await renderHook(() => {
      renders.status++;
      return useIsDownloaded('c1', 2, 'A/Book');
    });
    const cover = await renderHook(() => {
      renders.cover++;
      return useDownloadedCoverUri('c1', 2, 'A/Book');
    });
    // The control: a subscriber of the whole entry sees every tick.
    await renderHook(() => {
      renders.entry++;
      return useDownloadEntry('c1', 2, 'A/Book');
    });
    expect(status.result.current).toBe(false);
    expect(cover.result.current).toBeNull();
    const before = { ...renders };

    for (const progress of [0.2, 0.4, 0.6]) await patch({ progress, bytes: progress * 100 });
    expect(renders.entry).toBe(before.entry + 3);
    expect(renders.status).toBe(before.status);
    expect(renders.cover).toBe(before.cover);

    await patch({ status: 'downloaded', progress: 1 });
    expect(status.result.current).toBe(true);
    expect(cover.result.current).toBe('stale:cover');
    expect(renders.status).toBe(before.status + 1);
    expect(renders.cover).toBe(before.cover + 1);
  });

  it('answer false and null for a book with no download or one that failed', async () => {
    useDownloads.setState({ entries: { [key]: downloadedEntry({ status: 'error' }) } });
    expect((await renderHook(() => useIsDownloaded('c1', 2, 'A/Book'))).result.current).toBe(false);
    expect((await renderHook(() => useDownloadedCoverUri('c1', 2, 'A/Book'))).result.current).toBe(
      null,
    );
    expect((await renderHook(() => useIsDownloaded('c2', 2, 'A/Book'))).result.current).toBe(false);
  });
});

describe('relocateEntry (via hydrate)', () => {
  it('rewrites each saved file uri to engine.localUri(cid, libraryId, path, fileName(i, relPath)) and the cover to cover.jpg', async () => {
    const key = downloadKey('c1', 2, 'A/Book');
    await seed({ [key]: downloadedEntry() });

    await useDownloads.getState().hydrate();

    const e = useDownloads.getState().entries[key];
    expect(e).toBeDefined();
    // fileName(0, 'A/Book/01.mp3') === '0.mp3'; fileName(1, '…/02.mp3') === '1.mp3'.
    expect(e.manifest.files.map((f) => f.localUri)).toEqual([
      'live:c1:2:A/Book:0.mp3',
      'live:c1:2:A/Book:1.mp3',
    ]);
    // The cover is always re-resolved to the fixed 'cover.jpg' name.
    expect(e.manifest.coverUri).toBe('live:c1:2:A/Book:cover.jpg');
    // relPaths are preserved (only the absolute uri is rewritten).
    expect(e.manifest.files.map((f) => f.relPath)).toEqual(['A/Book/01.mp3', 'A/Book/02.mp3']);
  });

  it('is a no-op when engine.localUri is undefined (web)', async () => {
    // Web: localUri stable cache key, not a path → no relocation.
    mockEngine.localUri = undefined;
    const key = downloadKey('c1', 2, 'A/Book');
    await seed({ [key]: downloadedEntry() });

    await useDownloads.getState().hydrate();

    const e = useDownloads.getState().entries[key];
    expect(e.manifest.files.map((f) => f.localUri)).toEqual(['stale:01', 'stale:02']);
    expect(e.manifest.coverUri).toBe('stale:cover');
  });

  it('leaves a null cover null after relocation', async () => {
    const entry = downloadedEntry();
    entry.manifest.coverUri = null;
    const key = downloadKey('c1', 2, 'A/Book');
    await seed({ [key]: entry });

    await useDownloads.getState().hydrate();

    expect(useDownloads.getState().entries[key].manifest.coverUri).toBeNull();
  });
});

/** Hydrate one entry with these files and return the relocated uris. */
async function relocated(files: { relPath: string; localUri: string }[]): Promise<string[]> {
  const entry = downloadedEntry();
  entry.manifest.files = files;
  entry.manifest.coverUri = null;
  const key = downloadKey('c1', 2, 'A/Book');
  await seed({ [key]: entry });
  await useDownloads.getState().hydrate();
  return useDownloads.getState().entries[key]?.manifest.files.map((f) => f.localUri) ?? [];
}

describe('fileName extension handling (observed via the relocated uri)', () => {
  // The relocated uri is `live:<cid>:<lib>:<path>:<fileName(i, relPath)>`, so the
  // segment after the last ':' is exactly what `fileName` produced for that file.
  async function relocatedNameFor(relPath: string): Promise<string> {
    const [uri = ''] = await relocated([{ relPath, localUri: 'stale' }]);
    return uri.slice(uri.lastIndexOf(':') + 1);
  }

  it("keeps the extension when the dot is after the last slash ('A/B/track.mp3' → '0.mp3')", async () => {
    expect(await relocatedNameFor('A/B/track.mp3')).toBe('0.mp3');
  });

  it("yields just the index for a dotless name ('noext' → '0')", async () => {
    expect(await relocatedNameFor('noext')).toBe('0');
  });

  it('adds no extension when the only dot is in a parent dir, not the filename', async () => {
    // 'a.b/track' - the dot precedes the last slash, so it is not an extension.
    expect(await relocatedNameFor('a.b/track')).toBe('0');
  });

  it("names a Matroska file '.mp3' on iOS only (AVFoundation goes by the extension)", async () => {
    Platform.OS = 'ios';
    expect(await relocatedNameFor('A/B/track.mka')).toBe('0.mp3');
    expect(await relocatedNameFor('A/B/TRACK.MKA')).toBe('0.mp3');
    // Media3 sniffs the bytes and the web goes by Content-Type: raw Matroska keeps its name.
    for (const os of ['android', 'web'] as const) {
      Platform.OS = os;
      expect(await relocatedNameFor('A/B/track.mka')).toBe('0.mka');
    }
  });

  it('leaves every other extension as it is', async () => {
    for (const os of ['ios', 'android'] as const) {
      Platform.OS = os;
      expect(await relocatedNameFor('A/B/track.m4b')).toBe('0.m4b');
      expect(await relocatedNameFor('A/B/track.MP3')).toBe('0.MP3');
      expect(await relocatedNameFor('A/B/track.flac')).toBe('0.flac');
    }
  });
});

describe('relocateEntry keeps a saved file its own name', () => {
  // A real engine's uri ends in `/<name>` (the default fake's `:<name>` does not), so a
  // second hydrate reads the persisted name back as a device's would.
  const fileUri = (c: string, l: number, p: string, n: string) =>
    `file:///root/${c}/${l}/${encodeURIComponent(p)}/${n}`;
  const at = (name: string) => fileUri('c1', 2, 'A/Book', name);
  const key = downloadKey('c1', 2, 'A/Book');
  const uris = () => useDownloads.getState().entries[key]?.manifest.files.map((f) => f.localUri);
  async function hydrateAgain() {
    useDownloads.setState({ entries: {}, hydrated: false });
    await useDownloads.getState().hydrate();
  }

  /** Files on "disk", which `fileExists` and `renameFile` act on. */
  let disk: Set<string>;
  function onDisk(...names: string[]) {
    disk = new Set(names.map(at));
    mockEngine.localUri = jest.fn(fileUri);
    mockEngine.fileExists.mockImplementation(async (uri: string) => disk.has(uri));
    renameWorks();
  }
  const renames = () => mockEngine.renameFile?.mock.calls ?? [];
  function renameWorks() {
    mockEngine.renameFile = jest.fn(async (from: string, to: string) => {
      const dest = from.slice(0, from.lastIndexOf('/') + 1) + to;
      if (!disk.has(from) || disk.has(dest)) return false;
      disk.delete(from);
      disk.add(dest);
      return true;
    });
  }

  it("an existing '.mka' download still resolves to its file on Android and the web", async () => {
    renameWorks();
    for (const os of ['android', 'web'] as const) {
      Platform.OS = os;
      expect(
        await relocated([
          { relPath: 'A/Book/01.mka', localUri: 'file:///old/root/c1/2/A%2FBook/0.mka' },
          { relPath: 'A/Book/02.mka', localUri: 'https://host/_offline/c1/2/A%2FBook/1.mka' },
        ]),
      ).toEqual(['live:c1:2:A/Book:0.mka', 'live:c1:2:A/Book:1.mka']);
      expect(renames()).toEqual([]);
    }
  });

  it("falls back to fileName when the stored name is not this index's", async () => {
    Platform.OS = 'ios';
    expect(
      await relocated([
        { relPath: 'A/Book/01.mka', localUri: 'file:///old/root/3.mka' },
        { relPath: 'A/Book/02.mka', localUri: 'file:///old/root/track.mka' },
        { relPath: 'A/Book/03.mka', localUri: '' },
        // Percent-escaped in the uri, so not the name on disk.
        { relPath: 'A/Book/04.mka', localUri: 'file:///old/root/3.m%20ka' },
      ]),
    ).toEqual([
      'live:c1:2:A/Book:0.mp3',
      'live:c1:2:A/Book:1.mp3',
      'live:c1:2:A/Book:2.mp3',
      'live:c1:2:A/Book:3.mp3',
    ]);
  });

  it('keeps the name across launches on Android (the next hydrate reads the persisted uri back)', async () => {
    Platform.OS = 'android';
    onDisk('0.mka');
    expect(await relocated([{ relPath: 'A/Book/01.mka', localUri: at('0.mka') }])).toEqual([
      at('0.mka'),
    ]);
    await hydrateAgain();
    expect(uris()).toEqual([at('0.mka')]);
    expect(renames()).toEqual([]);
  });

  it("renames an old '<i>.mka' to '<i>.mp3' on disk on iOS, saves it, and leaves it there next launch", async () => {
    Platform.OS = 'ios';
    onDisk('0.mka', '1.m4a');
    expect(
      await relocated([
        { relPath: 'A/Book/01.mka', localUri: at('0.mka') },
        { relPath: 'A/Book/02.m4a', localUri: at('1.m4a') },
      ]),
    ).toEqual([at('0.mp3'), at('1.m4a')]);
    expect(renames()).toEqual([[at('0.mka'), '0.mp3']]);
    expect([...disk]).toEqual(expect.arrayContaining([at('0.mp3'), at('1.m4a')]));
    expect(useDownloads.getState().entries[key]?.status).toBe('downloaded');
    expect((await readPersisted())[key]?.manifest.files.map((f) => f.localUri)).toEqual([
      at('0.mp3'),
      at('1.m4a'),
    ]);
    mockEngine.renameFile?.mockClear();
    await hydrateAgain();
    expect(uris()).toEqual([at('0.mp3'), at('1.m4a')]);
    expect(renames()).toEqual([]);
  });

  it('keeps the old name, and the download, when the rename fails or throws', async () => {
    Platform.OS = 'ios';
    for (const fail of [async () => false, async () => Promise.reject(new Error('EPERM'))]) {
      onDisk('0.mka');
      mockEngine.renameFile = jest.fn(fail);
      expect(await relocated([{ relPath: 'A/Book/01.mka', localUri: at('0.mka') }])).toEqual([
        at('0.mka'),
      ]);
      expect(renames()).toEqual([[at('0.mka'), '0.mp3']]);
      expect(useDownloads.getState().entries[key]?.status).toBe('downloaded');
      expect(disk.has(at('0.mka'))).toBe(true);
    }
  });

  it('keeps the download when the rename moved the file but reported failure', async () => {
    Platform.OS = 'ios';
    for (const settle of [false, 'throw'] as const) {
      onDisk('0.mka');
      mockEngine.renameFile = jest.fn(async (from: string, to: string) => {
        disk.delete(from);
        disk.add(at(to));
        if (settle === 'throw') throw new Error('late failure');
        return false;
      });
      expect(await relocated([{ relPath: 'A/Book/01.mka', localUri: at('0.mka') }])).toEqual([
        at('0.mp3'),
      ]);
      expect(useDownloads.getState().entries[key]?.status).toBe('downloaded');
      expect(mockEngine.removeBook).not.toHaveBeenCalled();
    }
  });

  it("finds a file an earlier launch renamed before it saved the registry ('0.mka' listed, '0.mp3' on disk)", async () => {
    Platform.OS = 'ios';
    onDisk('0.mp3');
    expect(await relocated([{ relPath: 'A/Book/01.mka', localUri: at('0.mka') }])).toEqual([
      at('0.mp3'),
    ]);
    expect(renames()).toEqual([]);
    expect(useDownloads.getState().entries[key]?.status).toBe('downloaded');
  });

  it('keeps an iOS .mka name where the engine cannot rename', async () => {
    Platform.OS = 'ios';
    onDisk('0.mka');
    mockEngine.renameFile = undefined;
    expect(await relocated([{ relPath: 'A/Book/01.mka', localUri: at('0.mka') }])).toEqual([
      at('0.mka'),
    ]);
  });
});

describe('a new download names each file by fileName', () => {
  async function savedNames(): Promise<string[]> {
    mockResolveClient.mockReturnValue({
      coverUrl: () => 'cover',
      streamUrl: (_lib: number, p: string) => `stream:${p}`,
    } as unknown as ApiClient);
    mockEngine.downloadFile.mockImplementation(
      async (_c, _l, _p, name: string) => `live:c1:2:A/Book:${name}`,
    );
    const book = makeBook({
      files: ['01.mka', '02.m4a', '03.mp3'].map((n, i) => ({
        rel_path: `A/Book/${n}`,
        seq: i,
        duration: 60,
        format: n.slice(3),
        size: 100,
      })),
    });
    useDownloads.getState().download('c1', 2, book);
    await new Promise((r) => setTimeout(r, 0));

    const audio = mockEngine.downloadFile.mock.calls.filter((c) => c[3] !== 'cover.jpg');
    expect(audio.map((c) => c[4])).toEqual([
      'stream:A/Book/01.mka',
      'stream:A/Book/02.m4a',
      'stream:A/Book/03.mp3',
    ]);
    const e = useDownloads.getState().entries[downloadKey('c1', 2, 'A/Book')];
    expect(e?.status).toBe('downloaded');
    expect(e?.manifest.files.map((f) => f.localUri)).toEqual(
      audio.map((c) => `live:c1:2:A/Book:${c[3]}`),
    );
    return audio.map((c) => c[3] as string);
  }

  it("saves a '.mka' track as '<i>.mp3' on iOS and every other file under its own extension", async () => {
    Platform.OS = 'ios';
    expect(await savedNames()).toEqual(['0.mp3', '1.m4a', '2.mp3']);
  });

  it("keeps '.mka' on Android", async () => {
    Platform.OS = 'android';
    expect(await savedNames()).toEqual(['0.mka', '1.m4a', '2.mp3']);
  });
});

describe("a book's ebook rides along with its download (Bridge Phase 3b-2)", () => {
  const withEbook = () =>
    makeBook({
      files: [{ rel_path: 'A/Book/01.mp3', seq: 0, duration: 60, format: 'mp3', size: 100 }],
      ebook: { path: 'A/Book/Book.epub', size: 1000 },
    });
  function api() {
    mockResolveClient.mockReturnValue({
      coverUrl: () => 'cover',
      streamUrl: (_lib: number, p: string) => `stream:${p}`,
      ebookRequest: (lib: number, p: string) => ({
        url: `ebook:${lib}:${p}`,
        headers: { Authorization: 'Bearer t' },
      }),
    } as unknown as ApiClient);
  }
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  const entry = () => useDownloads.getState().entries[downloadKey('c1', 2, 'A/Book')];

  it('saves it as book.epub with the Authorization header (never a token in the url)', async () => {
    api();
    mockEngine.downloadFile.mockImplementation(
      async (_c, _l, _p, name: string) => `live:c1:2:A/Book:${name}`,
    );
    useDownloads.getState().download('c1', 2, withEbook());
    await settle();

    const call = mockEngine.downloadFile.mock.calls.find((c) => c[3] === 'book.epub');
    expect(call?.[4]).toBe('ebook:2:A/Book');
    expect(call?.[7]).toEqual({ Authorization: 'Bearer t' });
    expect(entry()?.status).toBe('downloaded');
    expect(entry()?.manifest.ebookUri).toBe('live:c1:2:A/Book:book.epub');
  });

  it('never fails the audio when the ebook fails: the book is downloaded without it', async () => {
    api();
    mockEngine.downloadFile.mockImplementation(async (_c, _l, _p, name: string) => {
      if (name === 'book.epub') throw new Error('server returned HTTP 404');
      return `live:c1:2:A/Book:${name}`;
    });
    useDownloads.getState().download('c1', 2, withEbook());
    await settle();

    expect(entry()?.status).toBe('downloaded');
    expect(entry()?.manifest.ebookUri).toBeUndefined();
    // Its size on the device is the audio's, not the audio's and the missing ebook's.
    expect(entry()?.totalBytes).toBe(100);
  });

  it('a cancel while the ebook downloads cancels the book', async () => {
    api();
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    mockEngine.downloadFile.mockImplementation(async (_c, _l, _p, name: string) => {
      if (name === 'book.epub') {
        // The listener cancels mid-transfer, and the engine rejects.
        useDownloads.getState().cancel('c1', 2, 'A/Book');
        throw abort;
      }
      return `live:c1:2:A/Book:${name}`;
    });
    useDownloads.getState().download('c1', 2, withEbook());
    await settle();

    expect(mockEngine.downloadFile.mock.calls.map((c) => c[3])).toEqual([
      'cover.jpg',
      '0.mp3',
      'book.epub',
    ]);
    // Deleted by the cancel, and again by the download once the transfer stopped (it can
    // write after the cancel's delete): the book never carries on without its ebook.
    expect(mockEngine.removeBook).toHaveBeenCalledTimes(2);
    expect(mockEngine.removeBook).toHaveBeenCalledWith('c1', 2, 'A/Book');
    expect(entry()).toBeUndefined();
  });

  it('comes after the audio: an attempt that fails on the audio never fetches it, a retry once', async () => {
    api();
    const book = makeBook({ files: threeFileBook().files, ebook: withEbook().ebook });
    const names = () => mockEngine.downloadFile.mock.calls.map((c) => c[3]);
    mockEngine.downloadFile.mockImplementation(async (_c, _l, _p, name: string) => {
      if (name === '2.mp3') throw new TypeError('Failed to fetch');
      return `live:c1:2:A/Book:${name}`;
    });
    useDownloads.getState().download('c1', 2, book);
    await settle();

    expect(names()).toEqual(['cover.jpg', '0.mp3', '1.mp3', '2.mp3']);
    expect(entry()?.status).toBe('error');
    expect(entry()?.failure).toEqual({ kind: 'network', kept: 2 / 3 });

    // The retry fetches the file that failed, then the ebook.
    mockEngine.downloadFile.mockClear();
    mockEngine.downloadFile.mockImplementation(
      async (_c, _l, _p, name: string) => `live:c1:2:A/Book:${name}`,
    );
    useDownloads.getState().download('c1', 2, book);
    await settle();

    expect(names()).toEqual(['cover.jpg', '2.mp3', 'book.epub']);
    expect(entry()?.status).toBe('downloaded');
    expect(entry()?.manifest.ebookUri).toBe('live:c1:2:A/Book:book.epub');
  });

  it('asks for no ebook for a book without one', async () => {
    api();
    mockEngine.downloadFile.mockImplementation(
      async (_c, _l, _p, name: string) => `live:c1:2:A/Book:${name}`,
    );
    useDownloads.getState().download('c1', 2, makeBook({ files: withEbook().files }));
    await settle();

    expect(mockEngine.downloadFile.mock.calls.map((c) => c[3])).toEqual(['cover.jpg', '0.mp3']);
    expect(entry()?.manifest.ebookUri).toBeUndefined();
  });

  it('counts the ebook in the progress, the total and the bytes kept', async () => {
    api();
    const seen: { progress: number; totalBytes: number }[] = [];
    mockEngine.downloadFile.mockImplementation(
      async (_c, _l, _p, name: string, _u, onProgress?: (w: number, t: number) => void) => {
        if (name === 'book.epub') {
          // The audio is done: the button must not read 100% while the ebook downloads.
          const e = entry();
          seen.push({ progress: e.progress, totalBytes: e.totalBytes });
          onProgress?.(1000, 1000);
        } else if (name === '0.mp3') onProgress?.(100, 100);
        return `live:c1:2:A/Book:${name}`;
      },
    );
    useDownloads.getState().download('c1', 2, withEbook());
    await settle();

    expect(seen).toEqual([{ progress: 0.5, totalBytes: 1100 }]);
    expect(entry()).toMatchObject({ status: 'downloaded', progress: 1, bytes: 1100 });
  });

  it("takes the app reader's cached copy instead of fetching the ebook again", async () => {
    api();
    mockEngine.copyFile = jest.fn(
      async (_c: string, _l: number, _p: string, name: string) => `live:c1:2:A/Book:${name}`,
    );
    mockCachedEbook.mockResolvedValue('cache:reader/book-1000.epub');
    mockEngine.downloadFile.mockImplementation(
      async (_c, _l, _p, name: string) => `live:c1:2:A/Book:${name}`,
    );
    useDownloads.getState().download('c1', 2, withEbook());
    await settle();

    expect(mockCachedEbook).toHaveBeenCalledWith({
      connectionId: 'c1',
      libraryId: 2,
      path: 'A/Book',
      size: 1000,
    });
    expect(mockEngine.copyFile).toHaveBeenCalledWith(
      'c1',
      2,
      'A/Book',
      'book.epub',
      'cache:reader/book-1000.epub',
    );
    expect(mockEngine.downloadFile.mock.calls.map((c) => c[3])).toEqual(['cover.jpg', '0.mp3']);
    expect(entry()?.manifest.ebookUri).toBe('live:c1:2:A/Book:book.epub');
    expect(entry()?.bytes).toBe(1000);
  });

  it("a cancel while the reader's copy is looked up drops the copy landing after it", async () => {
    api();
    mockEngine.copyFile = jest.fn(
      async (_c: string, _l: number, _p: string, name: string) => `live:c1:2:A/Book:${name}`,
    );
    mockCachedEbook.mockImplementation(async () => {
      useDownloads.getState().cancel('c1', 2, 'A/Book');
      return 'cache:reader/book-1000.epub';
    });
    mockEngine.downloadFile.mockImplementation(
      async (_c, _l, _p, name: string) => `live:c1:2:A/Book:${name}`,
    );
    useDownloads.getState().download('c1', 2, withEbook());
    await settle();

    // The copy takes no signal: it lands after the cancel's delete, and goes with it.
    const copiedAt = mockEngine.copyFile.mock.invocationCallOrder[0];
    expect(mockEngine.removeBook).toHaveBeenCalledTimes(2);
    expect(mockEngine.removeBook.mock.invocationCallOrder.at(-1)).toBeGreaterThan(copiedAt);
    expect(entry()).toBeUndefined();
  });

  it('fetches the ebook when there is no cached copy, or copying it fails', async () => {
    api();
    mockEngine.copyFile = jest.fn(async () => {
      throw new Error('disk full');
    });
    mockEngine.downloadFile.mockImplementation(
      async (_c, _l, _p, name: string) => `live:c1:2:A/Book:${name}`,
    );
    mockCachedEbook.mockResolvedValue('cache:reader/book-1000.epub');
    useDownloads.getState().download('c1', 2, withEbook());
    await settle();

    expect(mockEngine.downloadFile.mock.calls.map((c) => c[3])).toContain('book.epub');
    expect(entry()?.manifest.ebookUri).toBe('live:c1:2:A/Book:book.epub');
  });

  it('relocates a saved ebook to book.epub under the live root, and adds none', async () => {
    const key = downloadKey('c1', 2, 'A/Book');
    const saved = downloadedEntry();
    saved.manifest.ebookUri = 'stale:book.epub';
    await seed({ [key]: saved, [downloadKey('c1', 2, 'B')]: downloadedEntry({ path: 'B' }) });

    await useDownloads.getState().hydrate();

    const entries = useDownloads.getState().entries;
    expect(entries[key].manifest.ebookUri).toBe('live:c1:2:A/Book:book.epub');
    expect(entries[downloadKey('c1', 2, 'B')].manifest.ebookUri).toBeUndefined();
  });
});

describe("a book's read-along map rides along with its EPUB (Bridge Phase 3c)", () => {
  const REF = { connectionId: 'c1', libraryId: 2, path: 'A/Book' };
  const key = downloadKey('c1', 2, 'A/Book');
  const withEbook = (p: Partial<Book> = {}) =>
    makeBook({
      files: [{ rel_path: 'A/Book/01.mp3', seq: 0, duration: 60, format: 'mp3', size: 100 }],
      ebook: { path: 'A/Book/Book.epub', size: 1000 },
      ...p,
    });
  const API = {
    coverUrl: () => 'cover',
    streamUrl: (_lib: number, p: string) => `stream:${p}`,
    ebookRequest: () => ({ url: 'ebook', headers: {} }),
  } as unknown as ApiClient;
  /** The server's flags as the cache holds them. */
  const serves = (readalong: boolean) =>
    mockGetQueryData.mockImplementation((k: unknown) =>
      Array.isArray(k) && k[0] === 'server' ? { capabilities: { readalong } } : undefined,
    );
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  const entry = () => useDownloads.getState().entries[key];

  beforeEach(() => {
    mockResolveClient.mockReturnValue(API);
    mockEngine.downloadFile.mockImplementation(
      async (_c, _l, _p, name: string) => `live:c1:2:A/Book:${name}`,
    );
  });

  it('keeps the map beside book.epub, with which map it is', async () => {
    serves(true);
    mockFetchReadalong.mockResolvedValue({
      uri: 'live:c1:2:A/Book:readalong.json',
      generatedAt: 'g1',
    });
    useDownloads
      .getState()
      .download('c1', 2, withEbook({ readalong: { state: 'ready', generated_at: 'g1' } }));
    await settle();
    expect(mockFetchReadalong).toHaveBeenCalledWith(API, REF, expect.any(AbortSignal));
    expect(entry()?.status).toBe('downloaded');
    expect(entry()?.manifest).toMatchObject({
      ebookUri: 'live:c1:2:A/Book:book.epub',
      readalongUri: 'live:c1:2:A/Book:readalong.json',
      readalongGeneratedAt: 'g1',
    });
  });

  it('asks for none from a server without maps, for a stale map, or without the EPUB', async () => {
    serves(false);
    useDownloads.getState().download('c1', 2, withEbook());
    await settle();
    expect(mockFetchReadalong).not.toHaveBeenCalled();
    expect(entry()?.manifest.readalongUri).toBeUndefined();

    await useDownloads.getState().remove('c1', 2, 'A/Book');
    serves(true);
    useDownloads
      .getState()
      .download('c1', 2, withEbook({ readalong: { state: 'stale', reason: 'audio_changed' } }));
    await settle();
    expect(mockFetchReadalong).not.toHaveBeenCalled();

    await useDownloads.getState().remove('c1', 2, 'A/Book');
    mockEngine.downloadFile.mockImplementation(async (_c, _l, _p, name: string) => {
      if (name === 'book.epub') throw new Error('HTTP 404');
      return `live:c1:2:A/Book:${name}`;
    });
    useDownloads.getState().download('c1', 2, withEbook());
    await settle();
    expect(mockFetchReadalong).not.toHaveBeenCalled();
  });

  it('downloads the book without a map it could not get', async () => {
    serves(true);
    useDownloads.getState().download('c1', 2, withEbook());
    await settle();
    expect(mockFetchReadalong).toHaveBeenCalled();
    expect(entry()?.status).toBe('downloaded');
    expect(entry()?.manifest.readalongUri).toBeUndefined();
  });

  it('finds the map again under the live storage root on launch', async () => {
    const e = downloadedEntry();
    e.manifest = {
      ...e.manifest,
      ebookUri: 'stale:book.epub',
      readalongUri: 'stale:readalong.json',
      readalongGeneratedAt: 'g1',
    };
    await seed({ [key]: e });
    await useDownloads.getState().hydrate();
    expect(entry()?.manifest.readalongUri).toBe('live:c1:2:A/Book:readalong.json');
  });

  it("names the kept map's generated_at only with the EPUB beside it", async () => {
    const e = downloadedEntry();
    e.manifest = { ...e.manifest, readalongUri: 'x', readalongGeneratedAt: 'g1' };
    useDownloads.setState({ entries: { [key]: e } });
    const { result, rerender } = await renderHook(() => useDownloadedReadalong('c1', 2, 'A/Book'));
    expect(result.current).toBeUndefined();
    await act(async () => {
      useDownloads.setState({
        entries: { [key]: { ...e, manifest: { ...e.manifest, ebookUri: 'book' } } },
      });
    });
    await rerender({});
    expect(result.current).toBe('g1');
  });

  describe('startReadalongRefresh', () => {
    const answer = (
      data: unknown,
      manual?: boolean,
      k: unknown[] = ['item', 'c1', 2, 'A/Book'],
    ) => {
      for (const l of mockCacheListeners) {
        l({ type: 'updated', query: { queryKey: k }, action: { type: 'success', data, manual } });
      }
    };
    const kept = (generatedAt = 'g1') => {
      const e = downloadedEntry();
      e.manifest = {
        ...e.manifest,
        ebookUri: 'live:book.epub',
        readalongUri: 'live:readalong.json',
        readalongGeneratedAt: generatedAt,
      };
      useDownloads.setState({ entries: { [key]: e } });
      return e;
    };
    let stop: () => void = () => {};
    beforeEach(() => {
      serves(true);
      stop = startReadalongRefresh();
    });
    afterEach(() => stop());

    it('fetches the map again once it was made again', async () => {
      kept('g1');
      mockFetchReadalong.mockResolvedValue({ uri: 'live:readalong.json', generatedAt: 'g2' });
      answer(makeBook({ readalong: { state: 'ready', generated_at: 'g2' } }));
      await settle();
      expect(mockFetchReadalong).toHaveBeenCalledWith(API, REF);
      expect(entry()?.manifest.readalongGeneratedAt).toBe('g2');
    });

    it('drops the kept map once the server has none ready (stale, or gone)', async () => {
      kept('g1');
      answer(makeBook({ readalong: { state: 'stale', reason: 'ebook_changed' } }));
      await settle();
      expect(mockRemoveReadalong).toHaveBeenCalledWith(REF);
      expect(entry()?.manifest.readalongUri).toBeUndefined();
      expect(entry()?.manifest.readalongGeneratedAt).toBeUndefined();
      expect(mockFetchReadalong).not.toHaveBeenCalled();
    });

    it('leaves the same map, a seed, another book and an older server alone', async () => {
      const e = kept('g1');
      answer(makeBook({ readalong: { state: 'ready', generated_at: 'g1' } }));
      answer(makeBook(), true);
      answer(makeBook(), false, ['item', 'c1', 2, 'B/Other']);
      answer(makeBook(), false, ['chapters', 'c1', 2, 'A/Book']);
      serves(false);
      answer(makeBook());
      await settle();
      expect(entry()).toBe(e);
      expect(mockFetchReadalong).not.toHaveBeenCalled();
      expect(mockRemoveReadalong).not.toHaveBeenCalled();
    });

    it('tries a map that keeps failing once per launch, not on every answer', async () => {
      kept('g1');
      const made = makeBook({ readalong: { state: 'ready', generated_at: 'g9' } });
      answer(made);
      await settle();
      answer(made);
      await settle();
      expect(mockFetchReadalong).toHaveBeenCalledTimes(1);
      expect(entry()?.manifest.readalongUri).toBeUndefined();
    });
  });
});

describe('hydrate pruning', () => {
  it('keeps a fully-present downloaded entry', async () => {
    mockEngine.fileExists.mockResolvedValue(true);
    const key = downloadKey('c1', 2, 'A/Book');
    await seed({ [key]: downloadedEntry() });

    await useDownloads.getState().hydrate();

    expect(useDownloads.getState().entries[key]).toBeDefined();
    expect(mockEngine.removeBook).not.toHaveBeenCalled();
    // The cleaned registry is persisted back.
    expect(Object.keys(await readPersisted())).toEqual([key]);
  });

  it('prunes and removeBook-s an entry whose files are missing on disk', async () => {
    mockEngine.fileExists.mockResolvedValue(false); // a file vanished after a rebuild
    const key = downloadKey('c1', 2, 'A/Book');
    await seed({ [key]: downloadedEntry() });

    await useDownloads.getState().hydrate();

    expect(useDownloads.getState().entries[key]).toBeUndefined();
    expect(mockEngine.removeBook).toHaveBeenCalledWith('c1', 2, 'A/Book');
    expect(await readPersisted()).toEqual({});
  });

  it('keeps an entry whose files are not where it says while an identity move is on its way', async () => {
    const { setIdentityMovePending } =
      jest.requireActual<typeof import('@/lib/connection-id')>('@/lib/connection-id');
    mockEngine.fileExists.mockResolvedValue(false); // moved to the new id's folder already
    const key = downloadKey('c1', 2, 'A/Book');
    await seed({ [key]: downloadedEntry() });
    setIdentityMovePending(true);
    try {
      await useDownloads.getState().hydrate();
    } finally {
      setIdentityMovePending(false);
    }
    expect(useDownloads.getState().entries[key]).toBeDefined();
    expect(mockEngine.removeBook).not.toHaveBeenCalled();
    expect(await readPersisted()).toHaveProperty([key]);
  });

  it('prunes a download that finished no file before the app closed', async () => {
    const entry = downloadedEntry({ status: 'downloading', progress: 0.1 });
    entry.manifest.files = [];
    const key = downloadKey('c1', 2, 'A/Book');
    await seed({ [key]: entry });

    await useDownloads.getState().hydrate();

    expect(useDownloads.getState().entries[key]).toBeUndefined();
    expect(mockEngine.removeBook).toHaveBeenCalledWith('c1', 2, 'A/Book');
  });

  it('keeps an interrupted download as a failure holding its finished files', async () => {
    const key = downloadKey('c1', 2, 'A/Book');
    const entry = downloadedEntry({ status: 'downloading', progress: 0.5 });
    entry.manifest.book = threeFileBook();
    entry.manifest.files = [{ relPath: 'A/Book/00.mp3', localUri: 'stale:0', bytes: 100 }];
    await seed({ [key]: entry });

    await useDownloads.getState().hydrate();

    const revived = useDownloads.getState().entries[key];
    expect(revived).toMatchObject({
      status: 'error',
      progress: 1 / 3,
      bytes: 100,
      failure: { kind: 'interrupted', kept: 1 / 3 },
    });
    expect(mockEngine.removeBook).not.toHaveBeenCalled();
    expect((await readPersisted())[key]?.status).toBe('error');
  });

  it('drops a kept failure, and its folder, when one of its files is gone', async () => {
    const key = downloadKey('c1', 2, 'A/Book');
    const entry = downloadedEntry({ status: 'error', failure: { kind: 'network', kept: 2 / 3 } });
    entry.manifest.book = threeFileBook();
    mockEngine.fileExists.mockImplementation(async (uri: string) => !uri.endsWith(':1.mp3'));
    await seed({ [key]: entry });

    await useDownloads.getState().hydrate();

    expect(useDownloads.getState().entries[key]).toBeUndefined();
    expect(mockEngine.removeBook).toHaveBeenCalledWith('c1', 2, 'A/Book');
  });

  it('prunes a downloaded entry that has no files', async () => {
    const entry = downloadedEntry();
    entry.manifest.files = [];
    const key = downloadKey('c1', 2, 'A/Book');
    await seed({ [key]: entry });

    await useDownloads.getState().hydrate();

    expect(useDownloads.getState().entries[key]).toBeUndefined();
  });

  it('sets hydrated and marks itself unsupported when the engine is not supported', async () => {
    mockEngine.supported = false;
    await useDownloads.getState().hydrate();
    expect(useDownloads.getState().hydrated).toBe(true);
    expect(useDownloads.getState().supported).toBe(false);
  });
});

describe('reviveEntry', () => {
  const failed = (over: Partial<DownloadEntry> = {}) => {
    const e = downloadedEntry({
      status: 'error',
      error: 'Failed to fetch',
      failure: { kind: 'network', kept: 0.9 },
      ...over,
    });
    e.manifest.book = threeFileBook();
    return e;
  };

  it('keeps a downloaded book as it is', () => {
    const e = downloadedEntry();
    expect(reviveEntry(e, true)).toBe(e);
  });

  it("keeps a failure's cause, with the share its files really hold", () => {
    expect(reviveEntry(failed(), true)).toMatchObject({
      status: 'error',
      error: 'Failed to fetch',
      failure: { kind: 'network', kept: 2 / 3 },
      progress: 2 / 3,
    });
  });

  it('calls a download the app closed in the middle of interrupted', () => {
    for (const status of ['queued', 'downloading'] as const) {
      expect(reviveEntry(failed({ status, failure: undefined }), true)?.failure).toEqual({
        kind: 'interrupted',
        kept: 2 / 3,
      });
    }
  });

  it('drops an entry with a file missing, or with no finished file', () => {
    expect(reviveEntry(failed(), false)).toBeNull();
    expect(reviveEntry(downloadedEntry(), false)).toBeNull();
    const none = failed();
    none.manifest.files = [];
    expect(reviveEntry(none, true)).toBeNull();
  });
});

describe("refreshing a downloaded book's chapters", () => {
  // The two files `downloadedEntry` lists, as the server's chapters answer names them.
  const fresh = (
    paths = ['A/Book/01.mp3', 'A/Book/02.mp3'],
    over: Partial<ChaptersResponse> = {},
  ): ChaptersResponse => ({
    library_id: 2,
    path: 'A/Book',
    duration: 120,
    is_folder: true,
    files: paths.map((rel_path, seq) => ({ rel_path, seq, duration: 60, format: 'mp3', size: 1 })),
    chapters: paths.map((file_path, index) => ({
      index,
      title: `Chapter ${index + 1}`,
      file_index: index,
      file_path,
      start: 0,
      end: 60,
      book_offset: index * 60,
    })),
    chapters_source: 'community',
    ...over,
  });
  /** The order a downloaded book's queue plays its files in: its chapters'. */
  const playOrder = (manifest: DownloadManifest) =>
    bookFileSpecs(manifest.book, manifest.chapters ?? undefined).map((s) => s.path);
  /** The query cache holds `data` as A/Book's chapters answer. */
  const cacheHolds = (data: ChaptersResponse) =>
    mockGetQueryData.mockImplementation((k: unknown) =>
      Array.isArray(k) && k[0] === 'chapters' && k[3] === 'A/Book' ? data : undefined,
    );
  afterEach(() => mockGetQueryData.mockReset());

  describe('refreshedChapters', () => {
    it('takes the fresh chapters when the audio files are the same', () => {
      const e = downloadedEntry();
      const next = refreshedChapters(e.manifest, fresh());
      expect(next?.chapters?.chapters_source).toBe('community');
      // Only the chapters move: the local audio and the rest stay as they were.
      expect(next).toEqual({ ...e.manifest, chapters: fresh() });
      expect(next?.files).toBe(e.manifest.files);
    });

    it('leaves the manifest alone when the files differ (a re-download)', () => {
      const e = downloadedEntry();
      expect(refreshedChapters(e.manifest, fresh(['A/Book/01.mp3']))).toBeNull();
      expect(refreshedChapters(e.manifest, fresh(['A/Book/01.mp3', 'A/Book/03.mp3']))).toBeNull();
      expect(refreshedChapters(e.manifest, fresh(['A/Book/01.mp3', 'A/Book/01.mp3']))).toBeNull();
      expect(
        refreshedChapters(e.manifest, fresh(['A/Book/01.mp3', 'A/Book/02.mp3', 'A/Book/03.mp3'])),
      ).toBeNull();
    });

    it('never takes the same files in another order (only a start that plays it does)', () => {
      const e = downloadedEntry();
      e.manifest.chapters = fresh(undefined, { chapters_source: undefined });
      expect(refreshedChapters(e.manifest, fresh(['A/Book/02.mp3', 'A/Book/01.mp3']))).toBeNull();
    });

    it('keeps each file on its own audio across a launch once its book took a new order', async () => {
      // Two extensions: a file named for another one's index would be missing on disk, and
      // the launch would drop the book and delete its folder.
      const paths = ['A/Book/01.mp3', 'A/Book/02.m4a'];
      const e = downloadedEntry();
      e.manifest.chapters = fresh(paths, { chapters_source: undefined });
      e.manifest.files = [
        { relPath: paths[0], localUri: 'live:c1:2:A/Book:0.mp3' },
        { relPath: paths[1], localUri: 'live:c1:2:A/Book:1.m4a' },
      ];
      const onDisk = new Set(e.manifest.files.map((f) => f.localUri));
      mockEngine.fileExists.mockImplementation(async (uri: string) => onDisk.has(uri));
      const key = downloadKey('c1', 2, 'A/Book');
      useDownloads.setState({ entries: { [key]: e } });
      adoptStartedChapters(
        { connectionId: 'c1', libraryId: 2, path: 'A/Book' },
        fresh([paths[1], paths[0]]),
      );
      await seed({ [key]: useDownloads.getState().entries[key] });

      await useDownloads.getState().hydrate();

      const after = useDownloads.getState().entries[key];
      expect(after?.status).toBe('downloaded');
      expect(mockEngine.removeBook).not.toHaveBeenCalled();
      expect(after.manifest.files).toEqual(e.manifest.files);
      expect(playOrder(after.manifest)).toEqual([paths[1], paths[0]]);
    });

    it('leaves the manifest alone when a file at the same path changed size (replaced in place)', () => {
      const e = downloadedEntry();
      e.manifest.chapters = fresh(undefined, { chapters_source: undefined });
      const replaced = fresh();
      replaced.files = replaced.files.map((f, i) => (i === 1 ? { ...f, size: 2 } : f));
      expect(refreshedChapters(e.manifest, replaced)).toBeNull();
      // The same sizes: the community chapters are taken.
      expect(refreshedChapters(e.manifest, fresh())?.chapters?.chapters_source).toBe('community');
    });

    it('reads the files from the chapters when the answer lists none', () => {
      const e = downloadedEntry();
      expect(refreshedChapters(e.manifest, fresh(undefined, { files: [] }))).not.toBeNull();
    });

    it('changes nothing when the saved chapters are already these', () => {
      const e = downloadedEntry();
      e.manifest.chapters = fresh();
      expect(refreshedChapters(e.manifest, fresh())).toBeNull();
      // An unchanged refetch hands back the very same object.
      expect(refreshedChapters(e.manifest, e.manifest.chapters)).toBeNull();
    });
  });

  describe('startChapterRefresh', () => {
    const answer = (data: unknown, manual?: boolean, key = ['chapters', 'c1', 2, 'A/Book']) => {
      for (const l of mockCacheListeners) {
        l({ type: 'updated', query: { queryKey: key }, action: { type: 'success', data, manual } });
      }
    };
    let stop: () => void = () => {};
    // Fake timers, so the save `persistSoon` holds runs here and never leaks into the
    // next test (it would hold that test's save behind its own).
    beforeEach(() => {
      jest.useFakeTimers();
      stop = startChapterRefresh();
    });
    afterEach(() => {
      stop();
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    it("saves the server's new chapters for a downloaded book with the same files", async () => {
      const e = downloadedEntry();
      useDownloads.setState({ entries: { [downloadKey('c1', 2, 'A/Book')]: e } });
      answer(fresh());
      const now = useDownloads.getState().entries[downloadKey('c1', 2, 'A/Book')];
      expect(now.manifest.chapters).toEqual(fresh());
      expect(now.manifest.files).toBe(e.manifest.files);
    });

    it('saves a burst of answers once, a moment later', async () => {
      // Each book with its own two files, answered with its own.
      const bFiles = ['B/Book/01.mp3', 'B/Book/02.mp3'];
      const a = downloadedEntry();
      const b = downloadedEntry({ path: 'B/Book' });
      b.manifest = {
        ...b.manifest,
        book: makeBook({ rel_path: 'B/Book' }),
        files: bFiles.map((relPath, i) => ({ relPath, localUri: `stale:b${i}` })),
      };
      useDownloads.setState({
        entries: { [downloadKey('c1', 2, 'A/Book')]: a, [downloadKey('c1', 2, 'B/Book')]: b },
      });
      // The in-memory AsyncStorage's setItem is a jest.fn (jest.setup.ts): count its calls.
      const save = AsyncStorage.setItem as jest.Mock;
      save.mockClear();
      answer(fresh());
      answer(fresh(bFiles, { path: 'B/Book' }), false, ['chapters', 'c1', 2, 'B/Book']);
      expect(save).not.toHaveBeenCalled();
      jest.advanceTimersByTime(2000);
      expect(save).toHaveBeenCalledTimes(1);
      const saved = await readPersisted();
      for (const k of Object.keys(saved)) {
        expect(saved[k].manifest.chapters?.chapters_source).toBe('community');
      }
      expect(Object.keys(saved)).toHaveLength(2);
    });

    it('leaves it alone when the files differ, the answer is a seed, or the book is not downloaded', () => {
      const e = downloadedEntry();
      const key = downloadKey('c1', 2, 'A/Book');
      useDownloads.setState({ entries: { [key]: e } });
      answer(fresh(['A/Book/01.mp3', 'A/Book/09.mp3']));
      answer(fresh(), true);
      answer(fresh(), false, ['item', 'c1', 2, 'A/Book']);
      answer(fresh(), false, ['chapters', 'c2', 2, 'A/Book']);
      expect(useDownloads.getState().entries[key]).toBe(e);
      const queued = downloadedEntry({ status: 'queued' });
      useDownloads.setState({ entries: { [key]: queued } });
      answer(fresh());
      expect(useDownloads.getState().entries[key]).toBe(queued);
    });

    describe('a new file order', () => {
      const key = downloadKey('c1', 2, 'A/Book');
      const ref = { connectionId: 'c1', libraryId: 2, path: 'A/Book' };
      const reordered = () => fresh(['A/Book/02.mp3', 'A/Book/01.mp3']);
      const order = () => playOrder(useDownloads.getState().entries[key].manifest);
      beforeEach(() => {
        // Downloaded from the server's old answer (its own chapters, in the old order).
        const e = downloadedEntry();
        e.manifest.chapters = fresh(undefined, { chapters_source: undefined });
        useDownloads.setState({ entries: { [key]: e } });
      });

      it('never comes from a background answer: JS cannot see what a native engine holds', async () => {
        const e = useDownloads.getState().entries[key];
        answer(reordered());
        expect(useDownloads.getState().entries[key]).toBe(e);
        // Nor from one the cache held when launch read the registry.
        await seed({ [key]: e });
        cacheHolds(reordered());
        await useDownloads.getState().hydrate();
        expect(useDownloads.getState().entries[key].manifest.chapters).toEqual(e.manifest.chapters);
      });

      it('is taken by a start that played it, with its chapters, nothing downloaded again', async () => {
        const e = useDownloads.getState().entries[key];
        adoptStartedChapters(ref, reordered());
        const now = useDownloads.getState().entries[key];
        expect(now.manifest.chapters).toEqual(reordered());
        expect(order()).toEqual(['A/Book/02.mp3', 'A/Book/01.mp3']);
        // The local files stay as the download wrote them (a file's index is its name on disk).
        expect(now.manifest.files).toBe(e.manifest.files);
        // Saved at once: a JS restart right after the start must find the order it played.
        expect((await readPersisted())[key]?.manifest.chapters).toEqual(reordered());
      });

      it('is not taken from a start whose chapters name other files, or another size', () => {
        const e = useDownloads.getState().entries[key];
        adoptStartedChapters(ref, fresh(['A/Book/02.mp3', 'A/Book/03.mp3']));
        adoptStartedChapters(ref, fresh(['A/Book/02.mp3']));
        const resized = reordered();
        resized.files = resized.files.map((f) =>
          f.rel_path === 'A/Book/01.mp3' ? { ...f, size: 2 } : f,
        );
        adoptStartedChapters(ref, resized);
        adoptStartedChapters({ ...ref, path: 'B/Book' }, reordered());
        // The same order is the background refresh's to take, not a start's (it can be older).
        adoptStartedChapters(ref, fresh());
        expect(useDownloads.getState().entries[key]).toBe(e);
      });
    });

    it('takes the answers the cache held before it started, and saves them', async () => {
      stop();
      const key = downloadKey('c1', 2, 'A/Book');
      useDownloads.setState({ entries: { [key]: downloadedEntry() } });
      const save = AsyncStorage.setItem as jest.Mock;
      save.mockClear();
      // The cache answers for the downloaded book only.
      mockGetQueryData.mockImplementation((key) =>
        JSON.stringify(key) === JSON.stringify(['chapters', 'c1', 2, 'A/Book'])
          ? fresh()
          : undefined,
      );
      try {
        stop = startChapterRefresh();
      } finally {
        mockGetQueryData.mockImplementation(() => undefined);
      }
      expect(useDownloads.getState().entries[key].manifest.chapters).toEqual(fresh());
      jest.advanceTimersByTime(2000);
      expect(save).toHaveBeenCalledTimes(1);
      expect((await readPersisted())[key]?.manifest.chapters).toEqual(fresh());
    });

    it('changes nothing at start when the cache holds only the manifest seed', () => {
      stop();
      const key = downloadKey('c1', 2, 'A/Book');
      const e = downloadedEntry();
      e.manifest.chapters = fresh();
      useDownloads.setState({ entries: { [key]: e } });
      // The seed is the manifest's own chapters (`seedOfflineMeta`), here a copy.
      mockGetQueryData.mockImplementation(() => fresh());
      try {
        stop = startChapterRefresh();
      } finally {
        mockGetQueryData.mockImplementation(() => undefined);
      }
      expect(useDownloads.getState().entries[key]).toBe(e);
    });

    it('stops listening once unsubscribed', () => {
      const e = downloadedEntry();
      const key = downloadKey('c1', 2, 'A/Book');
      useDownloads.setState({ entries: { [key]: e } });
      stop();
      answer(fresh());
      expect(useDownloads.getState().entries[key]).toBe(e);
    });
  });

  // `startChapterRefresh` sees only answers for a book already downloaded: one that landed
  // before (while the files did, or before launch read the registry) is taken from the cache.
  describe('an answer that landed before the book was downloaded', () => {
    const key = downloadKey('c1', 2, 'A/Book');

    it('is taken when the download finishes', async () => {
      mockResolveClient.mockReturnValue({
        coverUrl: () => 'cover',
        streamUrl: (_lib: number, p: string) => `stream:${p}`,
      } as unknown as ApiClient);
      mockEngine.downloadFile.mockImplementation(
        async (_c, _l, _p, name: string) => `local:${name}`,
      );
      const before = fresh(undefined, { chapters_source: undefined });
      cacheHolds(fresh());
      useDownloads.getState().download('c1', 2, makeBook({ files: before.files }), before);
      await new Promise((r) => setTimeout(r, 0));
      const done = useDownloads.getState().entries[key];
      expect(done?.status).toBe('downloaded');
      expect(done?.manifest.chapters).toEqual(fresh());
    });

    it('is taken when launch reads the registry, and saved', async () => {
      await seed({ [key]: downloadedEntry() });
      cacheHolds(fresh());
      await useDownloads.getState().hydrate();
      expect(useDownloads.getState().entries[key]?.manifest.chapters).toEqual(fresh());
      expect((await readPersisted())[key]?.manifest.chapters).toEqual(fresh());
    });
  });
});

describe('hydrate concurrency', () => {
  it('preserves an entry added by a concurrent download() during hydrate', async () => {
    const savedKey = downloadKey('c1', 2, 'A/Book');
    await seed({ [savedKey]: downloadedEntry() });
    // Fire a download() for a different book while hydrate is mid-flight (on the first
    // fileExists probe of the entry being hydrated) - the exact clobber window.
    mockEngine.fileExists.mockImplementationOnce(async () => {
      useDownloads.getState().download('c1', 3, makeBook({ rel_path: 'Z/New' }));
      return true;
    });

    await useDownloads.getState().hydrate();

    // The hydrated entry survives AND the concurrently-added one is not clobbered by the
    // final set() rebuilt from the stale start-of-hydrate snapshot.
    expect(useDownloads.getState().entries[savedKey]?.status).toBe('downloaded');
    const concurrent = useDownloads.getState().entries[downloadKey('c1', 3, 'Z/New')];
    expect(concurrent).toBeDefined();
    expect(concurrent?.path).toBe('Z/New');
    // ...and it's persisted too, not just in memory.
    expect(Object.keys(await readPersisted())).toEqual(
      expect.arrayContaining([savedKey, downloadKey('c1', 3, 'Z/New')]),
    );
  });
});

describe('hydrate holds off what needs the registry', () => {
  const savedKey = downloadKey('c1', 2, 'A/Book');

  it('a download() of a saved book during hydrate answers exists, never fetching over it', async () => {
    await seed({ [savedKey]: downloadedEntry() });
    let outcome: Promise<unknown> | undefined;
    mockEngine.fileExists.mockImplementationOnce(async () => {
      outcome = useDownloads.getState().download('c1', 2, makeBook());
      return true;
    });
    await useDownloads.getState().hydrate();
    await expect(outcome).resolves.toBe('exists');
    expect(mockEngine.downloadFile).not.toHaveBeenCalled();
    expect(useDownloads.getState().entries[savedKey]?.status).toBe('downloaded');
  });

  it('a save during hydrate never writes over the saved registry', async () => {
    await seed({ [savedKey]: downloadedEntry() });
    let mid: Record<string, DownloadEntry> | undefined;
    mockEngine.fileExists.mockImplementationOnce(async () => {
      // cancel() saves the registry; mid-hydrate the live entries are still empty.
      useDownloads.getState().cancel('c1', 9, 'Other');
      await new Promise((r) => setTimeout(r, 0));
      mid = await readPersisted();
      return true;
    });
    await useDownloads.getState().hydrate();
    expect(Object.keys(mid ?? {})).toEqual([savedKey]);
    expect(Object.keys(await readPersisted())).toEqual([savedKey]);
  });

  it('a remove() during hydrate stays removed', async () => {
    await seed({ [savedKey]: downloadedEntry() });
    let removed: Promise<void> | undefined;
    mockEngine.fileExists.mockImplementationOnce(async () => {
      removed = useDownloads.getState().remove('c1', 2, 'A/Book');
      return true;
    });
    await useDownloads.getState().hydrate();
    await removed;
    expect(useDownloads.getState().entries[savedKey]).toBeUndefined();
    expect((await readPersisted())[savedKey]).toBeUndefined();
  });
});

describe('download() per-connection routing', () => {
  function fakeApi(): ApiClient {
    return {
      coverUrl: jest.fn((lib: number, path: string) => `cover:${lib}:${path}`),
      streamUrl: jest.fn((lib: number, path: string) => `stream:${lib}:${path}`),
    } as unknown as ApiClient;
  }

  function routeClients(map: Record<string, ApiClient | null>) {
    mockResolveClient.mockImplementation((cid: string) => map[cid] ?? null);
  }

  async function settle() {
    // Let the async runQueue/runOne microtasks drain (two macrotasks to be safe).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  it('stamps the entry connectionId and errors when that connection is gone', async () => {
    mockResolveClient.mockReturnValue(null); // connection removed → unroutable
    const key = downloadKey('c2', 2, 'A/Book');
    useDownloads.getState().download('c2', 2, makeBook());
    await settle();

    const e = useDownloads.getState().entries[key];
    expect(e?.connectionId).toBe('c2');
    expect(e?.status).toBe('error');
    expect(e?.error).toBe('Server connection removed');
  });

  it('resolves each entry through its OWN connection client (no shared-client race)', async () => {
    const c1 = fakeApi();
    const c2 = fakeApi();
    routeClients({ c1, c2 });
    mockEngine.downloadFile.mockResolvedValue('file:uri');

    useDownloads.getState().download('c1', 2, makeBook({ rel_path: 'A/One' }));
    useDownloads.getState().download('c2', 2, makeBook({ rel_path: 'A/Two' }));
    await settle();

    // Each download used its own server's client to build the media URLs.
    expect(c1.streamUrl as jest.Mock).toHaveBeenCalled();
    expect(c2.streamUrl as jest.Mock).toHaveBeenCalled();
    expect(useDownloads.getState().entries[downloadKey('c1', 2, 'A/One')]?.status).toBe(
      'downloaded',
    );
    expect(useDownloads.getState().entries[downloadKey('c2', 2, 'A/Two')]?.status).toBe(
      'downloaded',
    );
  });
});

// Bridge Phase 2d-1, decision 6.1: whoever asks (a tile, auto-download, keep-ahead).
describe('download() refuses a podcast episode', () => {
  it('is unsupported, and queues nothing', async () => {
    const episode = makeBook({
      episode: {
        show_path: 'Show',
        published: null,
        season: null,
        episode: null,
        episode_type: 'full',
        explicit: false,
        downloaded: true,
        duration_source: 'file',
        removed: false,
      },
    });
    await expect(useDownloads.getState().download('c1', 2, episode)).resolves.toBe('unsupported');
    expect(useDownloads.getState().entries[downloadKey('c1', 2, 'A/Book')]).toBeUndefined();
  });
});

describe('download() refuses a book this browser plays transcoded', () => {
  const prevOS = Platform.OS;
  afterEach(() => {
    Platform.OS = prevOS;
    mockGetQueryData.mockReset();
  });
  const ac3 = () => makeBook({ direct_playable: false, codec: 'ac3' });

  it('is a no-op on web when the server transcodes it (its raw files would not play offline)', async () => {
    Platform.OS = 'web';
    mockGetQueryData.mockReturnValue({ capabilities: { transcode: true } });
    // Said, not silent: keep-ahead plans around a book it can't keep.
    await expect(useDownloads.getState().download('c1', 2, ac3())).resolves.toBe('transcoded');
    expect(useDownloads.getState().entries[downloadKey('c1', 2, 'A/Book')]).toBeUndefined();
    expect(mockGetQueryData).toHaveBeenCalledWith(['server', 'c1']);
  });

  it('downloads as before without a transcoder, or off web', () => {
    Platform.OS = 'web';
    mockGetQueryData.mockReturnValue({ capabilities: { transcode: false } });
    useDownloads.getState().download('c1', 2, ac3());
    expect(useDownloads.getState().entries[downloadKey('c1', 2, 'A/Book')]).toBeDefined();

    useDownloads.setState({ entries: {} });
    Platform.OS = 'ios';
    mockGetQueryData.mockReturnValue({ capabilities: { transcode: true } });
    useDownloads.getState().download('c1', 2, ac3());
    expect(useDownloads.getState().entries[downloadKey('c1', 2, 'A/Book')]).toBeDefined();
  });

  // A list-shape book (`/books`, `/fs`, shelves, tiles) carries no `direct_playable`: on
  // web it is decided on its full item and chapters, else the book menu downloaded raw
  // files this browser could not play.
  describe('a list-shape book on web', () => {
    const listShape = () => makeBook({ title: 'From the list' });
    const lookup = (full: Book) =>
      mockFetchQuery.mockImplementation(async (o) =>
        o.queryKey[0] === 'item'
          ? full
          : { chapters: [], files: [], direct_playable: full.direct_playable },
      );
    beforeEach(() => {
      Platform.OS = 'web';
      mockGetQueryData.mockReturnValue({ capabilities: { transcode: true } });
      mockResolveClient.mockReturnValue({} as ApiClient);
    });
    afterEach(() => {
      mockFetchQuery.mockReset();
      mockResolveClient.mockReset().mockReturnValue(null);
      useDownloads.setState({ entries: {} });
    });

    it('is refused as transcoded when its full item says the browser cannot play it', async () => {
      lookup(ac3());
      await expect(useDownloads.getState().download('c1', 2, listShape())).resolves.toBe(
        'transcoded',
      );
      expect(useDownloads.getState().entries[downloadKey('c1', 2, 'A/Book')]).toBeUndefined();
      expect(mockFetchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['item', 'c1', 2, 'A/Book'] }),
      );
    });

    it('downloads its full item when the browser plays it directly', async () => {
      lookup(makeBook({ direct_playable: true, codec: 'mp3', title: 'Full item' }));
      await expect(useDownloads.getState().download('c1', 2, listShape())).resolves.toBe('queued');
      const entry = useDownloads.getState().entries[downloadKey('c1', 2, 'A/Book')];
      expect(entry?.manifest.book.title).toBe('Full item');
      expect(entry?.manifest.chapters).toEqual(expect.objectContaining({ direct_playable: true }));
    });

    it('never looks it up off web', async () => {
      Platform.OS = 'ios';
      await expect(useDownloads.getState().download('c1', 2, listShape())).resolves.toBe('queued');
      expect(mockFetchQuery).not.toHaveBeenCalled();
    });
  });
});

describe('a cancel or a failure (observed via the download error path)', () => {
  // download() → runQueue → runOne; a rejection from engine.downloadFile is a cancel (drop
  // the entry and its files quietly) only when the listener cancelled, which aborts the
  // download's own signal. Anything else is a failure (status:'error', keeping the files
  // that finished), whatever its message says. runOne resolves the entry's client via
  // resolveClient(entry.connectionId) - so it must return a usable api first.
  function fakeApi(): ApiClient {
    return {
      coverUrl: (lib: number, path: string) => `cover:${lib}:${path}`,
      streamUrl: (lib: number, path: string) => `stream:${lib}:${path}`,
      ebookRequest: (lib: number, path: string) => ({ url: `ebook:${lib}:${path}`, headers: {} }),
    } as unknown as ApiClient;
  }

  async function settle() {
    // Let the async runQueue/runOne microtasks drain.
    await new Promise((r) => setTimeout(r, 0));
  }

  // How Android reports a dropped connection (a Wi-Fi switch, a closed socket):
  // expo-file-system's UnableToDownloadException, not an AbortError. Read as a cancel, it
  // deleted the whole book.
  const DROPPED = 'Unable to download a file: Software caused connection abort';
  const key = downloadKey('c1', 2, 'A/Book');

  beforeEach(() => {
    mockResolveClient.mockReturnValue(fakeApi());
  });

  it('treats a rejection after the listener cancelled as a cancel → drops the entry and its files', async () => {
    const abort = new Error('cancelled by user');
    abort.name = 'AbortError';
    mockEngine.downloadFile.mockImplementation(async (_c, _l, _p, name: string) => {
      if (name === 'cover.jpg') return `local:${name}`;
      useDownloads.getState().cancel('c1', 2, 'A/Book');
      throw abort;
    });

    useDownloads.getState().download('c1', 2, makeBook());
    await settle();

    expect(useDownloads.getState().entries[key]).toBeUndefined();
    // Deleted by the cancel, and again by the download once the transfer stopped.
    expect(mockEngine.removeBook).toHaveBeenCalledTimes(2);
    expect(mockEngine.removeBook).toHaveBeenCalledWith('c1', 2, 'A/Book');
  });

  it('a cancel then Download again at once: the new download completes and stays (fe#174)', async () => {
    const abort = new Error('cancelled by user');
    abort.name = 'AbortError';
    let first = true;
    // The old transfer stops only after the listener has cancelled and asked again.
    let stopOld!: () => void;
    const oldStopped = new Promise<void>((r) => (stopOld = r));
    mockEngine.downloadFile.mockImplementation(
      async (_c, _l, _p, name: string, _u, onProgress?: (w: number, t: number) => void) => {
        if (name === 'cover.jpg') return `local:${name}`;
        if (first) {
          first = false;
          await oldStopped;
          // A last progress tick from the old transfer, after the new entry exists.
          onProgress?.(50, 100);
          throw abort;
        }
        return `local:${name}`;
      },
    );

    useDownloads.getState().download('c1', 2, makeBook());
    await settle();
    expect(useDownloads.getState().entries[key]?.status).toBe('downloading');

    useDownloads.getState().cancel('c1', 2, 'A/Book');
    useDownloads.getState().download('c1', 2, makeBook());
    expect(useDownloads.getState().entries[key]?.status).toBe('queued');
    stopOld();
    await settle();
    await settle();

    const e = useDownloads.getState().entries[key];
    expect(e?.status).toBe('downloaded');
    expect(e?.manifest.files).toHaveLength(1);
    // The old run cleared its files before the new one began writing.
    const removedAt = mockEngine.removeBook.mock.invocationCallOrder.at(-1) ?? 0;
    const lastWrite = mockEngine.downloadFile.mock.invocationCallOrder.at(-1) ?? 0;
    expect(removedAt).toBeLessThan(lastWrite);
    expect((await readPersisted())[key]?.status).toBe('downloaded');
  });

  it("keeps Android's dropped connection as a failure, with the files that finished", async () => {
    mockEngine.downloadFile.mockImplementation(async (_c, _l, _p, name: string) => {
      if (name === '1.mp3') throw new Error(DROPPED);
      return `local:${name}`;
    });

    useDownloads.getState().download('c1', 2, threeFileBook());
    await settle();

    const e = useDownloads.getState().entries[key];
    expect(e?.status).toBe('error');
    expect(e?.failure).toEqual({ kind: 'network', kept: 1 / 3 });
    expect(e?.manifest.files.map((f) => f.localUri)).toEqual(['local:0.mp3']);
    expect(mockEngine.removeBook).not.toHaveBeenCalled();
  });

  it('downloads the book without its ebook when the ebook drops that way', async () => {
    mockEngine.downloadFile.mockImplementation(async (_c, _l, _p, name: string) => {
      if (name === 'book.epub') throw new Error(DROPPED);
      return `local:${name}`;
    });

    const book = makeBook({ ebook: { path: 'A/Book/Book.epub', size: 1000 } });
    useDownloads.getState().download('c1', 2, book);
    await settle();

    const e = useDownloads.getState().entries[key];
    expect(e?.status).toBe('downloaded');
    expect(e?.manifest.ebookUri).toBeUndefined();
    expect(mockEngine.removeBook).not.toHaveBeenCalled();
  });

  it('marks any other failure as status:error and keeps the entry', async () => {
    mockEngine.downloadFile.mockRejectedValue(new Error('network exploded'));

    useDownloads.getState().download('c1', 2, makeBook());
    await settle();

    const e = useDownloads.getState().entries[key];
    expect(e?.status).toBe('error');
    expect(e?.error).toBe('network exploded');
  });
});

describe('onConnectionRemoved purge', () => {
  it('removes only the removed connection’s entries and removeBook-s them with its cid', async () => {
    const c1key = downloadKey('c1', 2, 'A/Book');
    const c2key = downloadKey('c2', 2, 'A/Book');
    useDownloads.setState({
      entries: {
        [c1key]: downloadedEntry({ connectionId: 'c1' }),
        [c2key]: downloadedEntry({ connectionId: 'c2' }),
      },
      hydrated: true,
    });

    await removalCleanup('c1');

    expect(useDownloads.getState().entries[c1key]).toBeUndefined();
    expect(useDownloads.getState().entries[c2key]).toBeDefined();
    expect(mockEngine.removeBook).toHaveBeenCalledWith('c1', 2, 'A/Book');
    expect(mockEngine.removeBook).not.toHaveBeenCalledWith('c2', 2, 'A/Book');
  });
});

describe('failures, retry and the session decline mark', () => {
  const api = {
    coverUrl: (lib: number, path: string) => `cover:${lib}:${path}`,
    streamUrl: (lib: number, path: string) => `stream:${lib}:${path}`,
  } as unknown as ApiClient;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  // A three-file book of 100 bytes per file.
  const book = makeBook({
    files: [0, 1, 2].map((i) => ({
      rel_path: `A/Book/0${i}.mp3`,
      seq: i,
      duration: 60,
      format: 'mp3',
      size: 100,
    })),
  });
  const key = downloadKey('c1', 2, 'A/Book');

  beforeEach(() => {
    mockResolveClient.mockReturnValue(api);
  });

  it('keeps the files that finished, classifies the cause, and a retry skips them', async () => {
    // Cover, file 0 and file 1 land; file 2 fails with a dropped connection.
    mockEngine.downloadFile.mockImplementation(
      async (_c: string, _l: number, _p: string, name: string, url: string, onProgress) => {
        if (url === 'stream:2:A/Book/02.mp3') throw new TypeError('Failed to fetch');
        onProgress?.(100, 100);
        return `local:${name}`;
      },
    );
    useDownloads.getState().download('c1', 2, book);
    await settle();

    const failed = useDownloads.getState().entries[key];
    expect(failed?.status).toBe('error');
    expect(failed?.failure).toEqual({ kind: 'network', kept: 2 / 3 });
    expect(failed?.manifest.files.map((f) => f.localUri)).toEqual(['local:0.mp3', 'local:1.mp3']);
    // The finished files stay on the device for the retry.
    expect(mockEngine.removeBook).not.toHaveBeenCalled();

    mockEngine.downloadFile.mockClear();
    mockEngine.downloadFile.mockImplementation(async (_c, _l, _p, name: string) => `local:${name}`);
    useDownloads.getState().download('c1', 2, book);
    await settle();

    const done = useDownloads.getState().entries[key];
    expect(done?.status).toBe('downloaded');
    expect(done?.failure).toBeUndefined();
    expect(done?.manifest.files.map((f) => f.relPath)).toEqual([
      'A/Book/00.mp3',
      'A/Book/01.mp3',
      'A/Book/02.mp3',
    ]);
    // Only the cover and the missing file were fetched again.
    expect(mockEngine.downloadFile.mock.calls.map((c) => c[3])).toEqual(['cover.jpg', '2.mp3']);
  });

  it('lists each finished file as it lands, so an app closed mid-way keeps them', async () => {
    const watch = jest.spyOn(AppState, 'addEventListener');
    let release: (uri: string) => void = () => {};
    mockEngine.downloadFile.mockImplementation(
      async (_c: string, _l: number, _p: string, name: string) =>
        name === '1.mp3' ? new Promise<string>((r) => (release = r)) : `local:${name}`,
    );
    useDownloads.getState().download('c1', 2, book);
    await settle();

    // File 0 is in; file 1 is still on its way. The listing is saved within a couple of
    // seconds, and at once when the app leaves the foreground.
    const onChange = watch.mock.calls.find(([type]) => type === 'change')?.[1];
    onChange?.('background');
    await settle();
    const persisted = (await readPersisted())[key];
    expect(persisted?.status).toBe('downloading');
    expect(persisted?.manifest.files.map((f) => f.localUri)).toEqual(['local:0.mp3']);

    release('local:1.mp3');
    await settle();
    expect(useDownloads.getState().entries[key]?.status).toBe('downloaded');
  });

  it('records an HTTP failure with its status and nothing kept', async () => {
    mockEngine.downloadFile.mockImplementation(async (_c, _l, _p, name: string) => {
      if (name !== 'cover.jpg') throw new Error('Download failed (503)');
      return `local:${name}`;
    });
    useDownloads.getState().download('c1', 2, book);
    await settle();
    expect(useDownloads.getState().entries[key]?.failure).toEqual({
      kind: 'server',
      status: 503,
      kept: 0,
    });
  });

  it('remembers a cancel or remove for the session, and a listener download lifts it', async () => {
    mockEngine.downloadFile.mockImplementation(async (_c, _l, _p, name: string) => `local:${name}`);
    expect(isDeclined('c1', 2, 'A/Book')).toBe(false);
    useDownloads.getState().cancel('c1', 2, 'A/Book');
    expect(isDeclined('c1', 2, 'A/Book')).toBe(true);

    // An automatic download neither downloads it nor lifts the mark: keep-ahead...
    useDownloads.getState().download('c1', 2, book, undefined, 'keep-ahead');
    await settle();
    expect(isDeclined('c1', 2, 'A/Book')).toBe(true);
    expect(useDownloads.getState().entries[key]).toBeUndefined();

    // ...nor the automatic download of the book being started.
    useDownloads.getState().download('c1', 2, book, undefined, 'auto');
    await settle();
    expect(isDeclined('c1', 2, 'A/Book')).toBe(true);
    expect(useDownloads.getState().entries[key]).toBeUndefined();

    // The listener asking lifts it.
    useDownloads.getState().download('c1', 2, book);
    expect(isDeclined('c1', 2, 'A/Book')).toBe(false);
    expect(useDownloads.getState().entries[key]?.origin).toBe('listener');
    await settle();

    // Removed again: an automatic download stays away once more.
    await useDownloads.getState().remove('c1', 2, 'A/Book');
    useDownloads.getState().download('c1', 2, book, undefined, 'auto');
    await settle();
    expect(useDownloads.getState().entries[key]).toBeUndefined();
  });
});

// Before the reserve tests: they leave a download that never finishes holding the
// module's one-at-a-time queue.
describe('the offline companion (community metadata kept with a download)', () => {
  const api = {
    coverUrl: (lib: number, path: string) => `cover:${lib}:${path}`,
    streamUrl: (lib: number, path: string) => `stream:${lib}:${path}`,
  } as unknown as ApiClient;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const payload = (savedAt = Date.parse('2026-05-01T10:00:00Z')) => ({
    v: 1,
    savedAt,
    previous: true,
    meta: { matched: false },
    works: [],
    server: { info: { capabilities: { metadata: true } }, savedAt },
  });
  // metaTried is module-level: give each test its own book so one test's attempt never
  // stands in for another's.
  let n = 0;
  const nextPath = () => `M/Book${++n}`;

  beforeEach(() => {
    mockResolveClient.mockReturnValue(api);
    mockEngine.downloadFile.mockImplementation(
      async (_c: string, _l: number, _p: string, name: string) => `local:${name}`,
    );
  });

  async function downloadOne(path: string) {
    useDownloads.getState().download('c1', 2, makeBook({ rel_path: path, files: undefined }));
    await settle();
    await settle();
  }

  it('keeps it once the book is downloaded: saved beside the files, marked, seeded', async () => {
    const path = nextPath();
    const p = payload();
    mockCapture.mockResolvedValue(p);
    const snapshot = { info: { capabilities: { metadata: true } }, savedAt: 7 };
    mockCurrentSnapshot.mockReturnValueOnce(snapshot);
    const watch = jest.spyOn(AppState, 'addEventListener');
    await downloadOne(path);
    const key = downloadKey('c1', 2, path);
    const entry = useDownloads.getState().entries[key];
    expect(entry?.status).toBe('downloaded');
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockWriteMeta).toHaveBeenCalledWith(expect.objectContaining({ path }), p);
    expect(entry?.manifest.meta).toEqual({ savedAt: '2026-05-01T10:00:00.000Z' });
    // The marker reaches storage within a couple of seconds, at once when the app leaves
    // the foreground (the payload itself is not in the registry).
    watch.mock.calls.findLast(([type]) => type === 'change')?.[1]('background');
    await settle();
    const saved = (await readPersisted())[key];
    expect(saved?.manifest.meta).toEqual({ savedAt: '2026-05-01T10:00:00.000Z' });
    expect(JSON.stringify(saved)).not.toContain('"works"');
    expect(mockSeedMeta).toHaveBeenCalledWith('c1', 2, path, p);
    // The server's answer, kept once for the connection.
    expect(mockSaveSnapshot).toHaveBeenCalledWith('c1', snapshot);
  });

  it('a book with nothing to keep downloads exactly as before, unmarked', async () => {
    const path = nextPath();
    await downloadOne(path);
    const entry = useDownloads.getState().entries[downloadKey('c1', 2, path)];
    expect(entry?.status).toBe('downloaded');
    expect(entry?.manifest.meta).toBeUndefined();
    expect(mockWriteMeta).not.toHaveBeenCalled();
  });

  it('a capture that fails never fails the download', async () => {
    const path = nextPath();
    mockCapture.mockRejectedValue(new Error('meta down'));
    await downloadOne(path);
    expect(useDownloads.getState().entries[downloadKey('c1', 2, path)]?.status).toBe('downloaded');
  });

  it('a removed book stops keeping its cache entries for good', async () => {
    const path = nextPath();
    mockCapture.mockResolvedValue(payload());
    await downloadOne(path);
    expect(mockRelease).not.toHaveBeenCalled();
    await useDownloads.getState().remove('c1', 2, path);
    expect(mockRelease).toHaveBeenCalledWith('c1', 2, path);
  });

  it('a book removed while its metadata was read keeps nothing', async () => {
    const path = nextPath();
    let release: (v: unknown) => void = () => {};
    mockCapture.mockImplementation(() => new Promise((r) => (release = r)));
    await downloadOne(path);
    await useDownloads.getState().remove('c1', 2, path);
    release(payload());
    await settle();
    expect(mockWriteMeta).not.toHaveBeenCalled();
    expect(useDownloads.getState().entries[downloadKey('c1', 2, path)]).toBeUndefined();
  });

  it('a book removed while its metadata was being written deletes the file', async () => {
    const path = nextPath();
    mockCapture.mockResolvedValue(payload());
    let release: (v: boolean) => void = () => {};
    mockWriteMeta.mockImplementation(() => new Promise((r) => (release = r)));
    await downloadOne(path);
    await useDownloads.getState().remove('c1', 2, path);
    release(true);
    await settle();
    expect(mockRemoveMeta).toHaveBeenCalledWith(expect.objectContaining({ path }));
  });

  it("on launch, seeds what each book kept and then the connection's kept /server answer", async () => {
    const path = nextPath();
    const kept = { info: { capabilities: { metadata: true } }, savedAt: 3 };
    mockReadSnapshots.mockResolvedValueOnce({ c1: kept });
    await seed({
      [downloadKey('c1', 2, path)]: downloadedEntry({
        path,
        manifest: { ...downloadedEntry().manifest, meta: { savedAt: '2026-05-01T10:00:00Z' } },
      }),
    });
    const p = { ...payload(Date.now() - 60_000), server: undefined };
    mockReadMeta.mockResolvedValue(p);
    await useDownloads.getState().hydrate();
    await settle();
    await settle();
    expect(mockSeedMeta).toHaveBeenCalledWith('c1', 2, path, p);
    expect(mockSeedServer).toHaveBeenCalledWith('c1', kept);
    // The book page's metadata is seeded before the flag that opens its gate.
    expect(mockSeedMeta.mock.invocationCallOrder[0]).toBeLessThan(
      mockSeedServer.mock.invocationCallOrder[0],
    );
    expect(mockSaveSnapshot).not.toHaveBeenCalled();
  });

  it('carries over the /server answer a file kept from before it had its own key', async () => {
    const path = nextPath();
    const older = payload(Date.now() - 60_000); // this week's: not read again
    await seed({
      [downloadKey('c1', 2, path)]: downloadedEntry({
        path,
        manifest: { ...downloadedEntry().manifest, meta: { savedAt: '2026-05-01T10:00:00Z' } },
      }),
    });
    mockReadMeta.mockResolvedValue(older);
    await useDownloads.getState().hydrate();
    await settle();
    await settle();
    expect(mockSeedMeta).toHaveBeenCalledWith('c1', 2, path, older);
    expect(mockSeedServer).toHaveBeenCalledWith('c1', older.server);
    // ... and keeps it under the connection's own key from now on.
    expect(mockSaveSnapshot).toHaveBeenCalledWith('c1', older.server);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("forgets a removed connection's /server answer with its downloads", async () => {
    const path = nextPath();
    await seed({ [downloadKey('c9', 2, path)]: downloadedEntry({ connectionId: 'c9', path }) });
    await useDownloads.getState().hydrate();
    await removalCleanup('c9');
    expect(mockForgetSnapshot).toHaveBeenCalledWith('c9');
  });

  it('fills in a download made before it was kept, once per launch', async () => {
    const path = nextPath();
    const key = downloadKey('c1', 2, path);
    await seed({ [key]: downloadedEntry({ path }) });
    mockCapture.mockResolvedValue(payload());
    await useDownloads.getState().hydrate();
    await settle();
    expect(mockReadMeta).not.toHaveBeenCalled(); // no marker, no file to read
    expect(mockHasMetadata).toHaveBeenCalledWith('c1');
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(useDownloads.getState().entries[key]?.manifest.meta).toBeDefined();

    // A second hydrate in the same launch (or a failure) asks no more.
    mockCapture.mockClear();
    await seed({ [key]: downloadedEntry({ path }) });
    await useDownloads.getState().hydrate();
    await settle();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('reads a copy older than a week again, keeping it when that fails', async () => {
    const path = nextPath();
    const key = downloadKey('c1', 2, path);
    await seed({
      [key]: downloadedEntry({
        path,
        manifest: { ...downloadedEntry().manifest, meta: { savedAt: '2026-05-01T10:00:00Z' } },
      }),
    });
    const stale = payload(Date.now() - 8 * 24 * 60 * 60_000);
    mockReadMeta.mockResolvedValue(stale);
    await useDownloads.getState().hydrate();
    await settle();
    expect(mockSeedMeta).toHaveBeenCalledWith('c1', 2, path, stale);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    // The capture found nothing: the kept copy and its marker stay.
    expect(mockWriteMeta).not.toHaveBeenCalled();
    expect(useDownloads.getState().entries[key]?.manifest.meta).toBeDefined();
  });

  it('leaves a copy from this week alone', async () => {
    const path = nextPath();
    await seed({
      [downloadKey('c1', 2, path)]: downloadedEntry({
        path,
        manifest: { ...downloadedEntry().manifest, meta: { savedAt: '2026-05-01T10:00:00Z' } },
      }),
    });
    mockReadMeta.mockResolvedValue(payload(Date.now() - 60_000));
    await useDownloads.getState().hydrate();
    await settle();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('fills in a download whose saved file is missing or unreadable', async () => {
    const path = nextPath();
    await seed({
      [downloadKey('c1', 2, path)]: downloadedEntry({
        path,
        manifest: { ...downloadedEntry().manifest, meta: { savedAt: '2026-05-01T10:00:00Z' } },
      }),
    });
    mockReadMeta.mockResolvedValue(null);
    await useDownloads.getState().hydrate();
    await settle();
    expect(mockSeedMeta).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it("asks nothing of a server without metadata, nor for a book that can't match", async () => {
    const a = nextPath();
    const b = nextPath();
    await seed({
      [downloadKey('c1', 2, a)]: downloadedEntry({ path: a }),
      [downloadKey('c2', 2, b)]: downloadedEntry({ connectionId: 'c2', path: b }),
    });
    mockHasMetadata.mockImplementation(async (cid: string) => cid !== 'c1');
    mockCanMatch.mockImplementation((e: DownloadEntry) => e.connectionId !== 'c2');
    await useDownloads.getState().hydrate();
    await settle();
    expect(mockHasMetadata).not.toHaveBeenCalledWith('c2');
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('download() keeps the reserve free for automatic downloads', () => {
  const GB = 1024 ** 3;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  // Never lands: the entry stays queued/downloading, so it counts as pending.
  beforeEach(() => {
    mockResolveClient.mockReturnValue({
      coverUrl: () => 'cover',
      streamUrl: () => 'stream',
    } as unknown as ApiClient);
    mockEngine.downloadFile.mockImplementation(() => new Promise(() => {}));
    // 64 GB disk: the reserve is 6.4 GB.
    mockEngine.storageEstimate.mockResolvedValue({
      scope: 'device',
      capacity: 64 * GB,
      free: 8 * GB,
    });
  });
  afterEach(() => mockEngine.storageEstimate.mockResolvedValue(null));

  it('skips an automatic download that would leave less than the reserve free', async () => {
    const big = makeBook({ rel_path: 'R/Big', size: 2 * GB });
    useDownloads.getState().download('c1', 2, big, undefined, 'auto');
    useDownloads.getState().download('c1', 2, big, undefined, 'keep-ahead');
    await settle();
    expect(useDownloads.getState().entries[downloadKey('c1', 2, 'R/Big')]).toBeUndefined();
    // The listener's own download is never held back.
    useDownloads.getState().download('c1', 2, big);
    expect(useDownloads.getState().entries[downloadKey('c1', 2, 'R/Big')]?.origin).toBe('listener');
  });

  it('counts queued downloads and estimates a book of unknown size', async () => {
    // 4 GB of room after the reserve; a queued 3.5 GB download leaves 0.5 GB.
    mockEngine.storageEstimate.mockResolvedValue({
      scope: 'device',
      capacity: 64 * GB,
      free: 10.4 * GB,
    });
    useDownloads.getState().download('c1', 2, makeBook({ rel_path: 'R/Queued', size: 3.5 * GB }));
    // size 0, ten hours: about 576 MB at 128 kbps, more than the 0.5 GB left.
    useDownloads
      .getState()
      .download('c1', 2, makeBook({ rel_path: 'R/Unknown', duration: 36_000 }), undefined, 'auto');
    await settle();
    expect(useDownloads.getState().entries[downloadKey('c1', 2, 'R/Unknown')]).toBeUndefined();
    // A small one still fits.
    useDownloads
      .getState()
      .download(
        'c1',
        2,
        makeBook({ rel_path: 'R/Small', size: 100 * 1024 ** 2 }),
        undefined,
        'auto',
      );
    await settle();
    expect(useDownloads.getState().entries[downloadKey('c1', 2, 'R/Small')]?.origin).toBe('auto');
  });

  it('says why it turned an automatic download away', async () => {
    const big = makeBook({ rel_path: 'R/Big2', size: 2 * GB });
    await expect(
      useDownloads.getState().download('c1', 2, big, undefined, 'keep-ahead'),
    ).resolves.toBe('no-space');
  });

  it("lets the book you start past keep-ahead's books still waiting, which step aside", async () => {
    // 4 GB of room after the reserve. Keep-ahead queued a 3 GB next book first.
    mockEngine.storageEstimate.mockResolvedValue({
      scope: 'device',
      capacity: 64 * GB,
      free: 10.4 * GB,
    });
    const ahead = makeBook({ rel_path: 'K/Next', size: 3 * GB });
    await expect(
      useDownloads.getState().download('c1', 2, ahead, undefined, 'keep-ahead'),
    ).resolves.toBe('queued');
    // The book the listener starts (2 GB) only fits without it.
    const started = makeBook({ rel_path: 'K/Started', size: 2 * GB });
    await expect(
      useDownloads.getState().download('c1', 2, started, undefined, 'auto'),
    ).resolves.toBe('queued');
    const entries = useDownloads.getState().entries;
    expect(entries[downloadKey('c1', 2, 'K/Started')]?.origin).toBe('auto');
    expect(entries[downloadKey('c1', 2, 'K/Next')]).toBeUndefined();
    // Not declined: keep-ahead may plan it again around the book you started.
    expect(isDeclined('c1', 2, 'K/Next')).toBe(false);
  });

  it("does not push a listener's own download aside", async () => {
    mockEngine.storageEstimate.mockResolvedValue({
      scope: 'device',
      capacity: 64 * GB,
      free: 10.4 * GB,
    });
    useDownloads.getState().download('c1', 2, makeBook({ rel_path: 'L/Mine', size: 3 * GB }));
    const started = makeBook({ rel_path: 'L/Started', size: 2 * GB });
    await expect(
      useDownloads.getState().download('c1', 2, started, undefined, 'auto'),
    ).resolves.toBe('no-space');
    expect(useDownloads.getState().entries[downloadKey('c1', 2, 'L/Mine')]).toBeDefined();
  });

  it('starts one when the room is not knowable', async () => {
    mockEngine.storageEstimate.mockRejectedValue(new Error('no estimate'));
    const book = makeBook({ rel_path: 'R/Any', size: 50 * GB });
    useDownloads.getState().download('c1', 2, book, undefined, 'keep-ahead');
    await settle();
    expect(useDownloads.getState().entries[downloadKey('c1', 2, 'R/Any')]?.origin).toBe(
      'keep-ahead',
    );
  });
});
