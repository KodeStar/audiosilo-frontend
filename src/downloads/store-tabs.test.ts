import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ApiClient } from '@/api/client';
import type { Book } from '@/api/types';
import type { DownloadEntry } from '@/downloads/types';

/**
 * The web player's tabs share one stored downloads registry (`audiosilo.downloads`) but
 * each holds its own entries in memory. Two tabs here are two copies of the store
 * (`jest.isolateModules`) over the same storage, with the store's collaborators faked as in
 * store.test.ts.
 */

jest.mock('@/downloads/engine', () => ({
  engine: {
    supported: true,
    localUri: (cid: string, lib: number, path: string, name: string) =>
      `live:${cid}:${lib}:${path}:${name}`,
    fileExists: async () => true,
    removeBook: jest.fn(async () => {}),
    downloadFile: async (cid: string, lib: number, path: string, name: string) =>
      `live:${cid}:${lib}:${path}:${name}`,
    storageEstimate: async () => null,
    verify: undefined,
    probe: undefined,
    totalBytesUsed: async () => 0,
    renameFile: undefined,
    writeText: async () => true,
  },
}));
jest.mock('@/api/server-snapshots', () => ({
  seedServerSnapshot: () => {},
  saveServerSnapshot: async () => {},
}));
const mockRelease = jest.fn();
jest.mock('@/downloads/offline-meta', () => ({
  canMatch: () => false,
  captureOfflineMeta: async () => null,
  writeOfflineMeta: async () => true,
  readOfflineMeta: async () => null,
  removeOfflineMeta: async () => {},
  seedOfflineMeta: () => {},
  seedQuery: () => {},
  serverHasMetadata: async () => false,
  whenSessionReady: async () => {},
  releaseOfflineBook: (...a: unknown[]) => mockRelease(...a),
}));
jest.mock('@/reader/ebook-file', () => ({ cachedEbookUri: async () => null }));
jest.mock('@/downloads/readalong-file', () => ({
  ...jest.requireActual('@/downloads/readalong-file'),
  fetchReadalongFile: async () => undefined,
  removeReadalongFile: async () => {},
  readReadalongFile: async () => null,
}));
jest.mock('@/downloads/episode-ready', () => ({
  waitForEpisode: () => {},
  stopWaiting: () => {},
  isWaiting: () => false,
}));
(globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback = (cb) =>
  setTimeout(cb, 0);
const mockClient = {
  coverUrl: () => 'cover',
  proxyHeadersFor: () => undefined,
  streamUrl: (_lib: number, p: string) => `stream:${p}`,
} as unknown as ApiClient;
jest.mock('@/api/connection-clients', () => ({ resolveClient: () => mockClient }));
const mockRemovalPurges: ((id: string) => Promise<void>)[] = [];
jest.mock('@/stores/session', () => ({
  onConnectionRemoved: (fn: (id: string) => Promise<void>) => {
    mockRemovalPurges.push(fn);
    return () => {};
  },
}));
jest.mock('@/lib/network', () => ({ canAutoDownload: async () => true }));
jest.mock('@/api/provider', () => ({
  queryClient: {
    getQueryCache: () => ({ subscribe: () => () => {} }),
    setQueryData: () => {},
    invalidateQueries: () => {},
    getQueryData: () => undefined,
    fetchQuery: () => Promise.reject(new Error('not mocked')),
  },
}));
jest.mock('@/api/podcast-cache', () => ({ markEpisodeOnServer: () => {} }));
jest.mock('@/api/hooks', () => ({
  useSavedProgress: () => undefined,
  cachedCapability: () => undefined,
  cachedShowTitle: () => undefined,
  qk: {
    item: (cid: string, lib: number, path: string) => ['item', cid, lib, path],
    progress: (cid: string, lib: number, path: string) => ['progress', cid, lib, path],
    chapters: (cid: string, lib: number, path: string) => ['chapters', cid, lib, path],
    server: (cid: string) => ['server', cid],
  },
  fetchFailFast: () => Promise.reject(new Error('not mocked')),
  itemQuery: (cid: string, _c: unknown, lib: number, path: string) => ({
    queryKey: ['item', cid, lib, path],
  }),
  chaptersQuery: (cid: string, _c: unknown, lib: number, path: string) => ({
    queryKey: ['chapters', cid, lib, path],
  }),
  bookKeyParts: () => null,
}));

type Store = typeof import('@/downloads/store');

/** One tab: its own copy of the store (its own memory) over the shared storage. */
function openTab(): Store {
  let tab!: Store;
  jest.isolateModules(() => {
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      __esModule: true,
      default: AsyncStorage,
    }));
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    tab = require('@/downloads/store') as Store;
  });
  return tab;
}

const KEY = 'audiosilo.downloads';

function book(path: string): Book {
  return {
    id: 1,
    library_id: 2,
    rel_path: path,
    is_folder: true,
    title: path,
    author: 'Author',
    series: '',
    series_index: 0,
    narrator: '',
    duration: 60,
    format: 'mp3',
    size: 100,
    direct_playable: true,
    files: [{ rel_path: `${path}/01.mp3`, seq: 0, duration: 60, format: 'mp3', size: 100 }],
  };
}

async function stored(): Promise<Record<string, DownloadEntry>> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as Record<string, DownloadEntry>) : {};
}

/** The stored registry as the other tabs' `storage` event carries it. */
const rawStored = () => AsyncStorage.getItem(KEY);

const settle = () => new Promise((r) => setTimeout(r, 10));

/** A tab's entry of a book. */
const entryOf = (tab: Store, path: string) =>
  tab.useDownloads.getState().entries[tab.downloadKey('c1', 2, path)];

beforeEach(async () => {
  await AsyncStorage.clear();
  mockRemovalPurges.length = 0;
});

describe('two tabs downloading (web)', () => {
  it("keeps both tabs' downloads in the stored registry", async () => {
    const a = openTab();
    const b = openTab();
    await Promise.all([a.useDownloads.getState().hydrate(), b.useDownloads.getState().hydrate()]);
    await a.useDownloads.getState().download('c1', 2, book('X/Book'));
    await settle();
    await b.useDownloads.getState().download('c1', 2, book('Y/Book'));
    await settle();
    expect(entryOf(a, 'X/Book')?.status).toBe('downloaded');
    expect(entryOf(b, 'Y/Book')?.status).toBe('downloaded');
    const saved = await stored();
    expect(saved[a.downloadKey('c1', 2, 'X/Book')]?.status).toBe('downloaded');
    expect(saved[a.downloadKey('c1', 2, 'Y/Book')]?.status).toBe('downloaded');
  });

  it("follows the other tab's finished downloads and removals, and never writes its old copy back", async () => {
    const a = openTab();
    const b = openTab();
    await Promise.all([a.useDownloads.getState().hydrate(), b.useDownloads.getState().hydrate()]);
    await a.useDownloads.getState().download('c1', 2, book('X/Book'));
    await settle();
    // The `storage` event in tab B.
    b.followStoredRegistry(await rawStored());
    expect(entryOf(b, 'X/Book')?.status).toBe('downloaded');

    // Removed in tab A: gone in tab B too, and tab B's next save leaves it out.
    await a.useDownloads.getState().remove('c1', 2, 'X/Book');
    mockRelease.mockClear();
    b.followStoredRegistry(await rawStored());
    expect(entryOf(b, 'X/Book')).toBeUndefined();
    // Its seeded item and chapters are no longer kept for good here either.
    expect(mockRelease).toHaveBeenCalledWith('c1', 2, 'X/Book');
    await b.useDownloads.getState().download('c1', 2, book('Y/Book'));
    await settle();
    expect(Object.keys(await stored())).toEqual([b.downloadKey('c1', 2, 'Y/Book')]);
  });

  it("a tab that has not heard of another tab's removal does not write the download back", async () => {
    const seeded = openTab();
    await seeded.useDownloads.getState().hydrate();
    await seeded.useDownloads.getState().download('c1', 2, book('X/Book'));
    await settle();
    // Two tabs open over the registry holding X.
    const a = openTab();
    const b = openTab();
    await Promise.all([a.useDownloads.getState().hydrate(), b.useDownloads.getState().hydrate()]);
    await a.useDownloads.getState().remove('c1', 2, 'X/Book');
    // Tab B saves a change of its own before the `storage` event reached it.
    await b.useDownloads.getState().download('c1', 2, book('Y/Book'));
    await settle();
    expect(entryOf(b, 'X/Book')?.status).toBe('downloaded');
    expect(Object.keys(await stored())).toEqual([b.downloadKey('c1', 2, 'Y/Book')]);
  });

  it("a removal waiting for its save is not undone by another tab's write heard meanwhile", async () => {
    const seeded = openTab();
    await seeded.useDownloads.getState().hydrate();
    await seeded.useDownloads.getState().download('c1', 2, book('X/Book'));
    await settle();
    const a = openTab();
    await a.useDownloads.getState().hydrate();
    const holdingX = await rawStored();
    a.useDownloads.getState().cancel('c1', 2, 'X/Book');
    // Another tab's save (the registry still holding X) is heard before tab A's takes the lock.
    a.followStoredRegistry(holdingX);
    await settle();
    expect(entryOf(a, 'X/Book')).toBeUndefined();
    expect(await stored()).toEqual({});
  });

  it('a tab reading the registry at launch does not write back what another tab removed meanwhile', async () => {
    const seeded = openTab();
    await seeded.useDownloads.getState().hydrate();
    await seeded.useDownloads.getState().download('c1', 2, book('X/Book'));
    await seeded.useDownloads.getState().download('c1', 2, book('Y/Book'));
    await settle();
    const a = openTab();
    await a.useDownloads.getState().hydrate();
    const b = openTab();
    const reading = b.useDownloads.getState().hydrate();
    await a.useDownloads.getState().remove('c1', 2, 'X/Book');
    await reading;
    await settle();
    expect(Object.keys(await stored())).toEqual([a.downloadKey('c1', 2, 'Y/Book')]);
  });

  it('a save storage refused is written by the next save', async () => {
    const a = openTab();
    await a.useDownloads.getState().hydrate();
    // Storage refuses the save of X finished (its last).
    const setItem = AsyncStorage.setItem as jest.Mock;
    const write = setItem.getMockImplementation()!;
    let refused = false;
    setItem.mockImplementation(async (key: string, value: string) => {
      if (!refused && key === KEY && value.includes('"status":"downloaded"')) {
        refused = true;
        throw new Error('quota');
      }
      return write(key, value);
    });
    try {
      await a.useDownloads.getState().download('c1', 2, book('X/Book'));
      await settle();
    } finally {
      setItem.mockImplementation(write);
    }
    expect(refused).toBe(true);
    await a.useDownloads.getState().download('c1', 2, book('Y/Book'));
    await settle();
    const saved = await stored();
    expect(saved[a.downloadKey('c1', 2, 'X/Book')]?.status).toBe('downloaded');
    expect(saved[a.downloadKey('c1', 2, 'Y/Book')]?.status).toBe('downloaded');
  });

  it("removing a connection takes another tab's downloads of it from the registry", async () => {
    const a = openTab();
    // Tab A's purges (its copy of the store's, and of what it imports).
    const purgesOfA = [...mockRemovalPurges];
    const b = openTab();
    await Promise.all([a.useDownloads.getState().hydrate(), b.useDownloads.getState().hydrate()]);
    await b.useDownloads.getState().download('c1', 2, book('Y/Book'));
    await settle();
    await Promise.all(purgesOfA.map((purge) => purge('c1')));
    expect(await stored()).toEqual({});
  });
});

// A finished download changes without a new `savedAt`: the other tab took its chapters from
// the server, its read-along map, its kept metadata.
it("follows another tab's change of a finished download that kept its savedAt", async () => {
  const a = openTab();
  const b = openTab();
  await Promise.all([a.useDownloads.getState().hydrate(), b.useDownloads.getState().hydrate()]);
  await a.useDownloads.getState().download('c1', 2, book('X/Book'));
  await settle();
  b.followStoredRegistry(await rawStored());
  const key = a.downloadKey('c1', 2, 'X/Book');
  const saved = await stored();
  const chapters = { chapters: [], duration: 60, source: 'community' };
  const changed = { ...saved[key], manifest: { ...saved[key].manifest, chapters } };
  await AsyncStorage.setItem(KEY, JSON.stringify({ [key]: changed }));
  b.followStoredRegistry(await rawStored());
  expect(entryOf(b, 'X/Book')?.manifest.savedAt).toBe(saved[key].manifest.savedAt);
  expect(entryOf(b, 'X/Book')?.manifest.chapters).toEqual(chapters);
});
