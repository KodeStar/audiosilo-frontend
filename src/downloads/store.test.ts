import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ApiClient } from '@/api/client';
import type { Book } from '@/api/types';
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
    verify: undefined,
    probe: undefined,
    totalBytesUsed: jest.fn(async () => 0),
  },
}));

// The connection-clients seam: runOne resolves each entry's own client via resolveClient.
jest.mock('@/api/connection-clients', () => ({
  resolveClient: jest.fn(() => null),
}));

// The store registers an onConnectionRemoved purge at import time.
jest.mock('@/stores/session', () => ({
  onConnectionRemoved: jest.fn(() => () => {}),
}));

// Avoid pulling the real React Query client / hooks graph into the unit test.
jest.mock('@/api/provider', () => ({
  queryClient: { setQueryData: jest.fn(), invalidateQueries: jest.fn() },
}));
jest.mock('@/api/hooks', () => ({
  qk: {
    item: (cid: string, lib: number, path: string) => ['item', cid, lib, path],
    chapters: (cid: string, lib: number, path: string) => ['chapters', cid, lib, path],
  },
}));

// Imported after the mocks so the store binds to the fakes above.
/* eslint-disable import/first */
import { resolveClient } from '@/api/connection-clients';
import { engine } from '@/downloads/engine';
import { downloadedCountFor, downloadKey, useDownloads } from '@/downloads/store';
import { onConnectionRemoved } from '@/stores/session';
/* eslint-enable import/first */

// Typed handle to the mocked engine's jest.fn members.
const mockEngine = engine as unknown as {
  supported: boolean;
  localUri: jest.Mock | undefined;
  fileExists: jest.Mock;
  removeBook: jest.Mock;
  downloadFile: jest.Mock;
  verify: ((uri: string) => Promise<boolean>) | undefined;
  probe: (() => Promise<boolean>) | undefined;
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
  mockEngine.verify = undefined;
  mockEngine.probe = undefined;
  // Reset the connection-clients seam so a per-test override can't leak.
  mockResolveClient.mockReset().mockReturnValue(null);
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

describe('fileName extension handling (observed via the relocated uri)', () => {
  // The relocated uri is `live:<cid>:<lib>:<path>:<fileName(i, relPath)>`, so the
  // segment after the last ':' is exactly what `fileName` produced for that file.
  async function relocatedNameFor(relPath: string): Promise<string> {
    const entry = downloadedEntry();
    entry.manifest.files = [{ relPath, localUri: 'stale' }];
    entry.manifest.coverUri = null;
    const key = downloadKey('c1', 2, 'A/Book');
    await seed({ [key]: entry });
    await useDownloads.getState().hydrate();
    const uri = useDownloads.getState().entries[key]?.manifest.files[0]?.localUri ?? '';
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

  it('prunes a partial (not-yet-downloaded) entry - partials never survive a relaunch', async () => {
    const key = downloadKey('c1', 2, 'A/Book');
    await seed({ [key]: downloadedEntry({ status: 'downloading', progress: 0.4 }) });

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

describe('isAbort (observed via the download error path)', () => {
  // download() → runQueue → runOne; runOne uses the private isAbort() to decide
  // whether a thrown error is a user cancel (drop the entry quietly) or a real
  // failure (mark status:'error'). We drive each branch by throwing the matching
  // error from engine.downloadFile. runOne resolves the entry's client via
  // resolveClient(entry.connectionId) - so it must return a usable api first.
  function fakeApi(): ApiClient {
    return {
      coverUrl: (lib: number, path: string) => `cover:${lib}:${path}`,
      streamUrl: (lib: number, path: string) => `stream:${lib}:${path}`,
    } as unknown as ApiClient;
  }

  async function settle() {
    // Let the async runQueue/runOne microtasks drain.
    await new Promise((r) => setTimeout(r, 0));
  }

  beforeEach(() => {
    mockResolveClient.mockReturnValue(fakeApi());
  });

  it('treats a DOMException-style AbortError (name) as a cancel → drops the entry', async () => {
    const abort = new Error('cancelled by user');
    abort.name = 'AbortError';
    mockEngine.downloadFile.mockRejectedValue(abort);

    const key = downloadKey('c1', 2, 'A/Book');
    useDownloads.getState().download('c1', 2, makeBook());
    await settle();

    // isAbort matched on name → cancelled path → entry removed, not error.
    expect(useDownloads.getState().entries[key]).toBeUndefined();
  });

  it('treats an error whose message matches /abort/i as a cancel', async () => {
    mockEngine.downloadFile.mockRejectedValue(new Error('The operation was Aborted.'));

    const key = downloadKey('c1', 2, 'A/Book');
    useDownloads.getState().download('c1', 2, makeBook());
    await settle();

    expect(useDownloads.getState().entries[key]).toBeUndefined();
  });

  it('marks a genuine (non-abort) failure as status:error and keeps the entry', async () => {
    mockEngine.downloadFile.mockRejectedValue(new Error('network exploded'));

    const key = downloadKey('c1', 2, 'A/Book');
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
