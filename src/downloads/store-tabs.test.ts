import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import type { ApiClient } from '@/api/client';
import type { Book } from '@/api/types';
import type { DownloadEntry } from '@/downloads/types';
import { tabChannel } from '@/lib/tab-channel';
import { fakeBrowser } from '@/testing/fake-browser';
import { fakeWebLocks } from '@/testing/fake-web-locks';

/**
 * The web player's tabs share one stored downloads registry (`audiosilo.downloads`) but
 * each holds its own entries in memory. Two tabs here are two copies of the store
 * (`jest.isolateModules`) over the same storage, with the store's collaborators faked as in
 * store.test.ts.
 */

// Every tab's folder deletions, and a transfer that waits while `mockTransfer.gate` is set
// (rejecting when its download is stopped, as a real one does).
const mockRemoveBook = jest.fn(async (..._a: unknown[]) => {});
const mockTransfer: { gate: Promise<void> | null } = { gate: null };
jest.mock('@/downloads/engine', () => ({
  engine: {
    supported: true,
    localUri: (cid: string, lib: number, path: string, name: string) =>
      `live:${cid}:${lib}:${path}:${name}`,
    fileExists: async () => true,
    removeBook: (...a: unknown[]) => mockRemoveBook(...a),
    downloadFile: async (
      cid: string,
      lib: number,
      path: string,
      name: string,
      _url: string,
      _onProgress: unknown,
      signal?: AbortSignal,
    ) => {
      if (mockTransfer.gate) {
        await Promise.race([
          mockTransfer.gate,
          new Promise((_, reject) =>
            signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
        ]);
      }
      return `live:${cid}:${lib}:${path}:${name}`;
    },
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
  mockRemoveBook.mockClear();
  mockTransfer.gate = null;
});

describe('two tabs downloading (web)', () => {
  const os = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'web';
  });
  afterEach(() => {
    Platform.OS = os;
  });

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

  it('a save whose read storage refuses is tried again until it lands, and says so meanwhile', async () => {
    const a = openTab();
    await a.useDownloads.getState().hydrate();
    const getItem = AsyncStorage.getItem as jest.Mock;
    const read = getItem.getMockImplementation()!;
    getItem.mockImplementation(async (key: string) => {
      if (key === KEY) throw new Error('storage');
      return read(key);
    });
    try {
      await a.useDownloads.getState().download('c1', 2, book('X/Book'));
      await settle();
      expect(entryOf(a, 'X/Book')?.status).toBe('downloaded');
      expect(await read(KEY)).toBeNull();
      expect(a.useDownloads.getState().saveFailing).toBe(true);
    } finally {
      getItem.mockImplementation(read);
    }
    // No other save comes: the retry writes it.
    await new Promise((r) => setTimeout(r, 1_100));
    expect((await stored())[a.downloadKey('c1', 2, 'X/Book')]?.status).toBe('downloaded');
    expect(a.useDownloads.getState().saveFailing).toBe(false);
  });

  it('a removed connection whose save storage refused is taken out by the retry, files too', async () => {
    const a = openTab();
    const purgesOfA = [...mockRemovalPurges];
    const b = openTab();
    await Promise.all([a.useDownloads.getState().hydrate(), b.useDownloads.getState().hydrate()]);
    await b.useDownloads.getState().download('c1', 2, book('Y/Book'));
    await settle();
    mockRemoveBook.mockClear();
    const getItem = AsyncStorage.getItem as jest.Mock;
    const read = getItem.getMockImplementation()!;
    getItem.mockImplementation(async (key: string) => {
      if (key === KEY) throw new Error('storage');
      return read(key);
    });
    try {
      await Promise.all(purgesOfA.map((purge) => purge('c1')));
      const kept = JSON.parse((await read(KEY)) as string) as Record<string, DownloadEntry>;
      expect(Object.keys(kept)).toEqual([b.downloadKey('c1', 2, 'Y/Book')]);
      expect(mockRemoveBook).not.toHaveBeenCalled();
    } finally {
      getItem.mockImplementation(read);
    }
    await new Promise((r) => setTimeout(r, 1_100));
    expect(await stored()).toEqual({});
    expect(mockRemoveBook).toHaveBeenCalledWith('c1', 2, 'Y/Book');
  });

  it('a download of a removed connection made since is not taken by its waiting drop', async () => {
    const a = openTab();
    const purgesOfA = [...mockRemovalPurges];
    const b = openTab();
    await Promise.all([a.useDownloads.getState().hydrate(), b.useDownloads.getState().hydrate()]);
    await b.useDownloads.getState().download('c1', 2, book('Y/Book'));
    await settle();
    mockRemoveBook.mockClear();
    const getItem = AsyncStorage.getItem as jest.Mock;
    const read = getItem.getMockImplementation()!;
    getItem.mockImplementation(async (key: string) => {
      if (key === KEY) throw new Error('storage');
      return read(key);
    });
    try {
      await Promise.all(purgesOfA.map((purge) => purge('c1')));
      // Signed in again (the same connection id): a new download, still not saved.
      await settle();
      await a.useDownloads.getState().download('c1', 2, book('Z/Book'));
      await settle();
      expect(entryOf(a, 'Z/Book')?.status).toBe('downloaded');
    } finally {
      getItem.mockImplementation(read);
    }
    await new Promise((r) => setTimeout(r, 1_100));
    expect(Object.keys(await stored())).toEqual([a.downloadKey('c1', 2, 'Z/Book')]);
    expect(mockRemoveBook).not.toHaveBeenCalledWith('c1', 2, 'Z/Book');
    expect(mockRemoveBook).toHaveBeenCalledWith('c1', 2, 'Y/Book');
  });

  it('the page going writes what this tab changed at once, its save still on its way', async () => {
    const seeded = openTab();
    await seeded.useDownloads.getState().hydrate();
    await seeded.useDownloads.getState().download('c1', 2, book('Y/Book'));
    await settle();
    const a = openTab();
    await a.useDownloads.getState().hydrate();
    // The page's storage, read and written in the moment (the registry another tab saved).
    let page = await rawStored();
    const storage = { getItem: () => page, setItem: (_k: string, v: string) => void (page = v) };
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const stop = a.watchRegistryOnPageHide(
      win as unknown as Window,
      doc as unknown as Document,
      storage,
    );
    // The async save does not get its read before the tab closes.
    let readable!: () => void;
    const gate = new Promise<void>((r) => (readable = r));
    const getItem = AsyncStorage.getItem as jest.Mock;
    const read = getItem.getMockImplementation()!;
    getItem.mockImplementation(async (key: string) => {
      if (key === KEY) await gate;
      return read(key);
    });
    try {
      await a.useDownloads.getState().download('c1', 2, book('X/Book'));
      await settle();
      expect(entryOf(a, 'X/Book')?.status).toBe('downloaded');
      win.dispatchEvent(new Event('pagehide'));
      const saved = JSON.parse(page!) as Record<string, DownloadEntry>;
      expect(saved[a.downloadKey('c1', 2, 'X/Book')]?.status).toBe('downloaded');
      expect(saved[a.downloadKey('c1', 2, 'Y/Book')]?.status).toBe('downloaded');
    } finally {
      stop();
      getItem.mockImplementation(read);
      readable();
      await settle();
    }
    // Not taken as saved: its own save writes the change again under the lock (a tab only
    // hidden lives on, and another tab's save can land over the page's write).
    expect((await stored())[a.downloadKey('c1', 2, 'X/Book')]?.status).toBe('downloaded');
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

// A download on its way lives only in its tab. A tab reloaded (or opened) meanwhile read its
// entry as cut short: marked Interrupted, its folder emptied under the transfer, and that
// written over the downloading tab's entry. The tab running a download now holds a Web Lock
// named for it, which the others see.
describe('a download running in another tab (web, Web Locks)', () => {
  const nav = globalThis.navigator as { locks?: unknown };
  const os = Platform.OS;
  const KEY_X = 'c1:2:X/Book';
  const LOCK_X = `audiosilo-download:${KEY_X}`;
  let locks: ReturnType<typeof fakeWebLocks>;
  let browser: ReturnType<typeof fakeBrowser>;
  let finish: () => void;

  beforeEach(() => {
    Platform.OS = 'web';
    locks = fakeWebLocks();
    Object.defineProperty(nav, 'locks', { configurable: true, value: locks });
    browser = fakeBrowser();
    mockTransfer.gate = new Promise<void>((r) => (finish = r));
  });
  afterEach(() => {
    finish();
    Platform.OS = os;
    delete nav.locks;
  });

  /** A tab of the browser, on its stop channel, its registry read. */
  async function launchTab(): Promise<Store> {
    const tab = openTab();
    tab.setDownloadStopChannelForTests(tabChannel('audiosilo-download-stop', browser.tab()));
    await tab.useDownloads.getState().hydrate();
    return tab;
  }

  /** Tab A, downloading X (its transfer waiting on `finish`). */
  async function downloadingTab(): Promise<Store> {
    const a = await launchTab();
    await a.useDownloads.getState().download('c1', 2, book('X/Book'));
    await settle();
    expect(entryOf(a, 'X/Book')?.status).toBe('downloading');
    expect(locks.names()).toContain(LOCK_X);
    return a;
  }

  it("a tab opened meanwhile shows it as that tab's: not Interrupted, its folder kept", async () => {
    const a = await downloadingTab();
    const b = await launchTab();
    await settle();
    expect(entryOf(b, 'X/Book')?.status).toBe('downloading');
    expect(b.useDownloads.getState().elsewhere[KEY_X]).toBe(true);
    expect(a.useDownloads.getState().elsewhere[KEY_X]).toBeUndefined();
    expect(mockRemoveBook).not.toHaveBeenCalled();
    expect((await stored())[KEY_X]?.status).toBe('downloading');
    // It finishes in tab A: shown downloaded in tab B, and the lock is let go.
    finish();
    await settle();
    expect(entryOf(a, 'X/Book')?.status).toBe('downloaded');
    b.followStoredRegistry(await rawStored());
    expect(entryOf(b, 'X/Book')?.status).toBe('downloaded');
    expect(b.useDownloads.getState().elsewhere[KEY_X]).toBeUndefined();
    expect(locks.names()).not.toContain(LOCK_X);
  });

  it('an open tab shows a download another tab starts, with its progress', async () => {
    const b = await launchTab();
    await downloadingTab();
    b.followStoredRegistry(await rawStored());
    await settle();
    expect(entryOf(b, 'X/Book')?.status).toBe('downloading');
    expect(b.useDownloads.getState().elsewhere[KEY_X]).toBe(true);
    // Never this tab's to save: the registry keeps the downloading tab's entry.
    await b.useDownloads.getState().download('c1', 2, book('X/Book'));
    expect((await stored())[KEY_X]?.status).toBe('downloading');
  });

  it('Cancel there asks the tab running it, which stops and removes it', async () => {
    const a = await downloadingTab();
    const b = await launchTab();
    b.useDownloads.getState().cancel('c1', 2, 'X/Book');
    // Nothing done in tab B itself: the transfer and its folder are tab A's.
    expect(entryOf(b, 'X/Book')?.status).toBe('downloading');
    expect(mockRemoveBook).not.toHaveBeenCalled();
    await settle();
    expect(entryOf(a, 'X/Book')).toBeUndefined();
    expect(mockRemoveBook).toHaveBeenCalledWith('c1', 2, 'X/Book');
    expect(await stored()).toEqual({});
    b.followStoredRegistry(await rawStored());
    expect(entryOf(b, 'X/Book')).toBeUndefined();
    expect(b.useDownloads.getState().elsewhere).toEqual({});
  });

  it('Remove there asks the tab running it too', async () => {
    const a = await downloadingTab();
    const b = await launchTab();
    await b.useDownloads.getState().remove('c1', 2, 'X/Book');
    await settle();
    expect(entryOf(a, 'X/Book')).toBeUndefined();
    expect(await stored()).toEqual({});
  });

  it('the tab running it closed: cut short now, revived by the tab that showed it', async () => {
    await downloadingTab();
    const b = await launchTab();
    expect(b.useDownloads.getState().elsewhere[KEY_X]).toBe(true);
    // Tab A closes: the browser frees its lock, and nothing more is saved from it.
    locks.close(LOCK_X);
    await settle();
    expect(entryOf(b, 'X/Book')).toMatchObject({
      status: 'error',
      failure: { kind: 'interrupted' },
    });
    expect(b.useDownloads.getState().elsewhere).toEqual({});
    expect((await stored())[KEY_X]?.status).toBe('error');
  });

  it('keeps its lock while storage refuses the save of its end', async () => {
    const a = await downloadingTab();
    const setItem = AsyncStorage.setItem as jest.Mock;
    const write = setItem.getMockImplementation()!;
    setItem.mockImplementation(async (key: string, value: string) => {
      if (key === KEY) throw new Error('quota');
      return write(key, value);
    });
    try {
      finish();
      await settle();
      expect(entryOf(a, 'X/Book')?.status).toBe('downloaded');
      // Still stored as on its way: let go now, another tab would revive it as cut short.
      expect((await stored())[KEY_X]?.status).toBe('downloading');
      expect(locks.names()).toContain(LOCK_X);
    } finally {
      setItem.mockImplementation(write);
    }
    await a.useDownloads.getState().download('c1', 2, book('Y/Book'));
    await settle();
    expect((await stored())[KEY_X]?.status).toBe('downloaded');
    expect(locks.names()).not.toContain(LOCK_X);
  });

  // The save that lands after the refusal is the page going, with no change of the entries
  // to follow: it still lets the lock go (before its retry, which it stands in for).
  it('lets its lock go when the page-hide save lands the end storage refused', async () => {
    const a = await downloadingTab();
    const setItem = AsyncStorage.setItem as jest.Mock;
    const write = setItem.getMockImplementation()!;
    setItem.mockImplementation(async (key: string, value: string) => {
      if (key === KEY) throw new Error('quota');
      return write(key, value);
    });
    try {
      finish();
      await settle();
      expect(locks.names()).toContain(LOCK_X);
      expect(a.useDownloads.getState().saveFailing).toBe(true);
    } finally {
      setItem.mockImplementation(write);
    }
    let page: string | null = null;
    const storage = { getItem: () => page, setItem: (_k: string, v: string) => void (page = v) };
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const stop = a.watchRegistryOnPageHide(
      win as unknown as Window,
      doc as unknown as Document,
      storage,
    );
    try {
      win.dispatchEvent(new Event('pagehide'));
      await settle();
      expect((await stored())[KEY_X]?.status).toBe('downloaded');
      expect(a.useDownloads.getState().saveFailing).toBe(false);
      expect(locks.names()).not.toContain(LOCK_X);
    } finally {
      stop();
    }
  });

  // A retry starting in another tab: its lock taken, its new start not saved yet. Read as the
  // failure stored, a tab opened then offered Retry, which would start it a second time.
  it("a tab opened as another tab's retry starts shows it running there, not Retry", async () => {
    const failed: DownloadEntry = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'X/Book',
      title: 'X/Book',
      status: 'error',
      progress: 0.5,
      bytes: 50,
      totalBytes: 100,
      origin: 'listener',
      failure: { kind: 'network' },
      manifest: {
        book: book('X/Book'),
        chapters: null,
        files: [],
        coverUri: null,
        savedAt: '2026-11-01T00:00:00Z',
      },
    };
    await AsyncStorage.setItem(KEY, JSON.stringify({ [KEY_X]: failed }));
    let letGo!: () => void;
    void locks.request(LOCK_X, () => new Promise<void>((r) => (letGo = r)));
    const b = await launchTab();
    expect(entryOf(b, 'X/Book')?.status).toBe('queued');
    expect(entryOf(b, 'X/Book')?.failure).toBeUndefined();
    expect(b.useDownloads.getState().elsewhere[KEY_X]).toBe(true);
    // Never saved from here, and another change heard meanwhile leaves it that tab's.
    await settle();
    expect((await stored())[KEY_X]?.status).toBe('error');
    b.followStoredRegistry(await rawStored());
    expect(entryOf(b, 'X/Book')?.status).toBe('queued');
    // That tab let it go with nothing saved (it closed): the stored failure shows again.
    letGo();
    await settle();
    expect(entryOf(b, 'X/Book')).toMatchObject({ status: 'error', failure: { kind: 'network' } });
    expect(b.useDownloads.getState().elsewhere).toEqual({});
    expect((await stored())[KEY_X]?.status).toBe('error');
  });

  /** Tab B, launched, with the purges it registers for a removed connection. */
  async function removingTab(): Promise<{ b: Store; removeC1: () => Promise<unknown> }> {
    const before = mockRemovalPurges.length;
    const b = await launchTab();
    const purges = mockRemovalPurges.slice(before);
    return { b, removeC1: () => Promise.all(purges.map((purge) => purge('c1'))) };
  }

  // Removing its connection in another tab deleted its folder under the transfer, and the
  // tab running it wrote its entry back with its next save.
  it('removing its connection in another tab: the tab running it removes it', async () => {
    const a = await downloadingTab();
    const { b, removeC1 } = await removingTab();
    expect(b.useDownloads.getState().elsewhere[KEY_X]).toBe(true);
    await removeC1();
    await settle();
    expect(entryOf(a, 'X/Book')).toBeUndefined();
    expect(entryOf(b, 'X/Book')).toBeUndefined();
    expect(await stored()).toEqual({});
    expect(locks.names()).not.toContain(LOCK_X);
    expect(mockRemoveBook).toHaveBeenCalledWith('c1', 2, 'X/Book');
  });

  it('a tab running it that does not answer keeps its folder until it ends there', async () => {
    const a = await downloadingTab();
    // Tab A hears no request (a tab of an older build).
    a.setDownloadStopChannelForTests(null);
    const { b, removeC1 } = await removingTab();
    await removeC1();
    await settle();
    expect(mockRemoveBook).not.toHaveBeenCalled();
    expect(entryOf(b, 'X/Book')).toBeUndefined();
    expect((await stored())[KEY_X]?.status).toBe('downloading');
    // Tab A's saves of it are not shown here again: the connection is gone.
    b.followStoredRegistry(await rawStored());
    await settle();
    expect(entryOf(b, 'X/Book')).toBeUndefined();
    expect(b.useDownloads.getState().elsewhere).toEqual({});
    // It ends in tab A: then its entry and its files go.
    finish();
    await settle();
    expect(entryOf(a, 'X/Book')?.status).toBe('downloaded');
    expect(locks.names()).not.toContain(LOCK_X);
    expect(await stored()).toEqual({});
    expect(mockRemoveBook).toHaveBeenCalledWith('c1', 2, 'X/Book');
  });

  it('a tab running it that closes meanwhile: its entry and files go then', async () => {
    const a = await downloadingTab();
    a.setDownloadStopChannelForTests(null);
    const { removeC1 } = await removingTab();
    await removeC1();
    await settle();
    expect(mockRemoveBook).not.toHaveBeenCalled();
    locks.close(LOCK_X);
    await settle();
    expect(await stored()).toEqual({});
    expect(mockRemoveBook).toHaveBeenCalledWith('c1', 2, 'X/Book');
  });

  it('without Web Locks a tab cannot tell: cut short, as before', async () => {
    const a = await downloadingTab();
    Object.defineProperty(nav, 'locks', { configurable: true, value: undefined });
    const b = await launchTab();
    expect(entryOf(b, 'X/Book')?.status).toBe('error');
    expect(b.useDownloads.getState().elsewhere).toEqual({});
    expect(entryOf(a, 'X/Book')?.status).toBe('downloading');
  });
});
