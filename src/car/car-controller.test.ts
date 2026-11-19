import type {
  Book,
  ChaptersResponse,
  Collection,
  CollectionDetail,
  Progress,
  QueueEntry,
} from '@/api/types';
import type { OtherBookNews } from '@/playback/store';

import type { CarSnapshot } from './car-model';

// --- Mocks ---------------------------------------------------------------------------------

type MockBookmarkHandler = (
  trackIndex: number,
  positionInTrack: number,
  book?: { connectionId: string; libraryId: number; path: string },
  relPath?: string,
) => void;

const mockNative = {
  available: true,
  stopPlayback: jest.fn(async () => {}),
  setSnapshot: jest.fn(async (_json: string) => true),
  getLoadedBook: jest.fn(async (): Promise<unknown> => null),
  consumePendingBookmarks: jest.fn(async (): Promise<unknown[]> => []),
  connection: null as ((connected: boolean) => void) | null,
  playRequest: null as ((id: string) => void) | null,
  playCancel: null as ((id: string, replaced?: boolean) => void) | null,
  bookmark: null as MockBookmarkHandler | null,
  onConnection: jest.fn((h: (connected: boolean) => void) => {
    mockNative.connection = h;
    return () => {
      mockNative.connection = null;
    };
  }),
  onPlayRequest: jest.fn((h: (id: string) => void) => {
    mockNative.playRequest = h;
    return () => {
      mockNative.playRequest = null;
    };
  }),
  onPlayCancel: jest.fn((h: (id: string, replaced?: boolean) => void) => {
    mockNative.playCancel = h;
    return () => {
      mockNative.playCancel = null;
    };
  }),
  onBookmark: jest.fn((h: MockBookmarkHandler) => {
    mockNative.bookmark = h;
    return () => {
      mockNative.bookmark = null;
    };
  }),
};
jest.mock('./car-native', () => ({
  get carNative() {
    return mockNative;
  },
}));

jest.mock('./car-artwork', () => ({
  artworkName: (key: string, version?: string) => `${key}#${version ?? ''}.jpg`,
  artworkOnDisk: jest.fn(() => new Set(mockArtOnDisk.keys())),
  artworkUri: (name: string) => mockArtOnDisk.get(name),
  ensureArtwork: jest.fn(async (name: string) => {
    const uri = `file:///docs/car-artwork/${encodeURIComponent(name)}`;
    mockArtOnDisk.set(name, uri);
    return uri;
  }),
  pruneArtwork: jest.fn(),
}));
const mockArtOnDisk = new Map<string, string>();

jest.mock('@/lib/bootstrap', () => ({ bootstrapPlayback: jest.fn(async () => {}) }));

const mockEndCastForCar = jest.fn(async () => false);
jest.mock('@/cast/cast-session', () => ({ endCastForCar: () => mockEndCastForCar() }));

const mockStartBookInPlace = jest.fn(async (..._a: unknown[]) => true);
/** How the car starts a book: one its native side can still call off (`StartHow.wanted`). */
const carStart = { wanted: expect.any(Function), superseded: expect.any(Function) };
jest.mock('@/components/player/start-book', () => ({
  startBookInPlace: (...a: unknown[]) => mockStartBookInPlace(...a),
}));

// The device's own places (the mirror, the offline queue): read once per build.
const mockLocalPlaces: {
  mirror: Record<string, unknown>;
  queue: unknown[];
  pending: Set<string>;
  skews?: Record<string, number>;
} = {
  mirror: {},
  queue: [],
  pending: new Set(),
};
const mockReadLocalPlaces = jest.fn(async () => mockLocalPlaces);
jest.mock('@/playback/progress-sync', () => ({
  readLocalPlaces: () => mockReadLocalPlaces(),
  resumeLookupOf: jest.requireActual('@/playback/progress-sync').resumeLookupOf,
  placeSavedAt: jest.requireActual('@/playback/progress-sync').placeSavedAt,
}));

// The real model, with its play spec builder counted (rebuilt only when its inputs change).
jest.mock('./car-model', () => {
  const actual = jest.requireActual('./car-model');
  return { ...actual, playSpec: jest.fn(actual.playSpec) };
});

// The player store, reduced to what the controller reads.
type MockPlayerState = {
  nowPlaying: {
    connectionId: string;
    libraryId: number;
    path: string;
    queue: { offsets: number[] };
  } | null;
  snapshot: { state: string; trackIndex: number; position: number };
};
/** Whether the store follows a play asked from outside the app (`followsOutsidePlay`). */
let mockOutsidePlay = true;
/** The book the engine plays that the store has not adopted (`engineOtherBook`), else null. */
let mockEngineOther: { connectionId: string; libraryId: number; path: string } | null = null;
/** The store's word that the engine reported another book (`onOtherBookReported`). */
let mockOtherBookReported: ((news: OtherBookNews) => void) | null = null;
jest.mock('@/playback/store', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { create } = require('zustand');
  const usePlayer = create(() => ({
    nowPlaying: null,
    snapshot: { state: 'idle', trackIndex: 0, position: 0, duration: 0, rate: 1 },
    rate: 1,
    loadingBook: null,
    toggle: jest.fn(async () => {}),
    adoptLoaded: jest.fn(async () => true),
  }));
  return {
    usePlayer,
    followsOutsidePlay: () => mockOutsidePlay,
    engineOtherBook: () => mockEngineOther,
    onOtherBookReported: (listener: (news: OtherBookNews) => void) => {
      mockOtherBookReported = listener;
      return () => {
        if (mockOtherBookReported === listener) mockOtherBookReported = null;
      };
    },
    selectBookKey: (s: MockPlayerState) =>
      s.nowPlaying
        ? `${s.nowPlaying.connectionId}:${s.nowPlaying.libraryId}:${s.nowPlaying.path}`
        : null,
    selectBookPosition: (s: MockPlayerState) =>
      s.nowPlaying
        ? (s.nowPlaying.queue.offsets[s.snapshot.trackIndex] ?? 0) + s.snapshot.position
        : 0,
    selectIsPlaying: (s: MockPlayerState) => s.snapshot.state === 'playing',
    selectIsTransportLive: (s: MockPlayerState) =>
      s.snapshot.state === 'playing' || s.snapshot.state === 'loading',
  };
});

let mockCacheListener: ((event: unknown) => void) | null = null;
jest.mock('@/api/provider', () => ({
  queryClient: {
    getQueryData: jest.fn(() => undefined),
    invalidateQueries: jest.fn(),
    getQueryCache: () => ({
      subscribe: (fn: (event: unknown) => void) => {
        mockCacheListener = fn;
        return () => {
          mockCacheListener = null;
        };
      },
    }),
  },
}));

const mockCaps: Record<string, Record<string, boolean>> = {};
const mockAddBookmark = jest.fn(async (..._a: unknown[]) => ({ id: 1 }));
jest.mock('@/api/hooks', () => {
  const actual = jest.requireActual('@/api/hooks');
  return {
    ...actual,
    // Run the query function itself: the fake clients below answer.
    fetchFailFast: async (opts: { queryFn: unknown; queryKey: unknown }) => {
      if (typeof opts.queryFn !== 'function') throw new Error('skipped');
      return opts.queryFn({ queryKey: opts.queryKey, signal: undefined });
    },
    fetchCapabilities: async (cid: string) => mockCaps[cid] ?? {},
    cachedCapability: (cid: string, flag: string) => mockCaps[cid]?.[flag],
    addBookmark: (...a: unknown[]) => mockAddBookmark(...a),
  };
});

type FakeClient = ReturnType<typeof fakeClient>;
const mockClients: Record<string, FakeClient> = {};
let mockSessionReady = true;
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (cid: string) => mockClients[cid] ?? null,
  sessionReady: () => mockSessionReady,
}));

/* eslint-disable import/first */
import { AppState, Platform } from 'react-native';

import { queryClient } from '@/api/provider';
import { useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';
import { bootstrapPlayback } from '@/lib/bootstrap';
import i18n, { ensureLanguage } from '@/i18n';
import { setConnectionAliases } from '@/lib/connection-id';
import * as store from '@/playback/store';
import { useLibrarySelection } from '@/stores/library-selection';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession, type Connection } from '@/stores/session';
import { useSettings } from '@/stores/settings';
import * as storage from '@/lib/storage';
import { getItem, setItem } from '@/lib/storage';

import { artworkOnDisk, ensureArtwork, pruneArtwork } from './car-artwork';
import { isCarConnected, setCarConnected } from './car-connection';
import {
  forgetCarSync,
  handleCarPlayRequest,
  MIN_GAP_MS,
  SETTLE_MS,
  startCarSync,
} from './car-controller';
import { carItemId, playSpec } from './car-model';
/* eslint-enable import/first */

const usePlayer = store.usePlayer as unknown as {
  getState: () => {
    toggle: jest.Mock;
    adoptLoaded: jest.Mock;
  };
  setState: (s: object) => void;
};

// --- Fixtures ------------------------------------------------------------------------------

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
    narrator: '',
    duration: 7200,
    format: 'm4b',
    size: 0,
    ...p,
  };
}

function makeProgress(p: Partial<Progress>): Progress {
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

function fakeClient(data: {
  progress?: Progress[];
  queue?: QueueEntry[];
  books?: Book[];
  items?: Record<string, Book>;
  chapters?: Record<string, ChaptersResponse>;
  collections?: Collection[];
  details?: Record<number, CollectionDetail>;
}) {
  return {
    collections: jest.fn(async () => data.collections ?? []),
    collection: jest.fn(async (id: number) => {
      const d = data.details?.[id];
      if (!d) throw new Error('no collection');
      return d;
    }),
    allProgress: jest.fn(async () => data.progress ?? []),
    queue: jest.fn(async () => data.queue ?? []),
    libraries: jest.fn(async () => [{ id: 2, name: 'Books' }]),
    listBooks: jest.fn(async () => ({ books: data.books ?? [] })),
    item: jest.fn(async (_lib: number, path: string) => {
      const b = data.items?.[path];
      if (!b) throw new Error('no item');
      return b;
    }),
    chapters: jest.fn(async (_lib: number, path: string) => {
      const c = data.chapters?.[path];
      if (!c) throw new Error('no chapters');
      return c;
    }),
    coverUrl: (lib: number, path: string, opts?: { size?: number }) =>
      `https://srv/cover?lib=${lib}&path=${path}${opts?.size ? `&size=${opts.size}` : ''}&token=secret`,
    proxyHeadersFor: (_url: string): Record<string, string> | undefined => undefined,
  };
}

function connect(ids: string[]) {
  useSession.setState({
    status: 'authenticated',
    connections: ids.map(
      (id) =>
        ({ id, serverUrl: `https://${id}`, name: id, token: 'secret', user: {} }) as Connection,
    ),
    defaultConnectionId: ids[0] ?? null,
  });
}

const twoFileChapters: ChaptersResponse = {
  library_id: 2,
  path: 'D',
  duration: 200,
  is_folder: true,
  files: [
    { rel_path: 'D/1.mp3', seq: 0, duration: 100, format: 'mp3', size: 1 },
    { rel_path: 'D/2.mp3', seq: 1, duration: 100, format: 'mp3', size: 1 },
  ],
  chapters: [],
};

function downloaded(cid: string, path: string): DownloadEntry {
  return {
    connectionId: cid,
    libraryId: 2,
    path,
    title: path,
    status: 'downloaded',
    progress: 1,
    bytes: 0,
    totalBytes: 0,
    manifest: {
      book: makeBook({ rel_path: path, title: `Downloaded ${path}`, duration: 200 }),
      chapters: twoFileChapters,
      files: [
        { relPath: 'D/1.mp3', localUri: 'file:///d/1.mp3' },
        { relPath: 'D/2.mp3', localUri: 'file:///d/2.mp3' },
      ],
      coverUri: 'file:///d/cover.jpg',
      savedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

async function settle(ms = 0) {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function lastSnapshot(): CarSnapshot {
  const calls = mockNative.setSnapshot.mock.calls;
  return JSON.parse(calls[calls.length - 1][0]) as CarSnapshot;
}

const tab = (s: CarSnapshot, id: string) => s.tabs.find((t) => t.id === id);

let stop: () => void = () => {};
let appStateListener: ((state: string) => void) | null = null;

beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  appStateListener = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _t: string,
    fn: (s: string) => void,
  ) => {
    appStateListener = fn;
    return { remove: () => {} };
  }) as never);
  forgetCarSync();
  mockEngineOther = null;
  (queryClient.getQueryData as jest.Mock).mockImplementation(() => undefined);
  mockArtOnDisk.clear();
  for (const k of Object.keys(mockClients)) delete mockClients[k];
  for (const k of Object.keys(mockCaps)) delete mockCaps[k];
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  mockNative.available = true;
  mockNative.getLoadedBook.mockReset();
  mockNative.getLoadedBook.mockResolvedValue(null);
  usePlayer.setState({
    nowPlaying: null,
    snapshot: { state: 'idle', trackIndex: 0, position: 0, duration: 0, rate: 1 },
    rate: 1,
    loadingBook: null,
  });
  useDownloads.setState({ entries: {} });
  useLibrarySelection.setState({ selection: null, shown: null });
  mockLocalPlaces.mirror = {};
  mockLocalPlaces.queue = [];
  delete mockLocalPlaces.skews;
  connect([]);
  resetProfilesForTests();
  // A car has met this phone before (the snapshot's gate); the gate's own tests clear it.
  await setItem('audiosilo.carSeen', true);
});

afterEach(async () => {
  stop();
  stop = () => {};
  await setItem('audiosilo.carBookmarks', []);
  await setItem('audiosilo.carSeen', false);
  await setItem('audiosilo.carSnapshotWritten', false);
  await setItem('audiosilo.carResumable', null);
  jest.clearAllTimers();
  jest.useRealTimers();
});

// --- Tests ---------------------------------------------------------------------------------

describe('startCarSync', () => {
  it('does nothing on a binary without the car functions (and on the web, which has none)', async () => {
    mockNative.available = false;
    stop = startCarSync();
    await settle(5_000);
    expect(mockNative.onConnection).not.toHaveBeenCalled();
    expect(mockNative.onPlayRequest).not.toHaveBeenCalled();
    expect(mockNative.setSnapshot).not.toHaveBeenCalled();
  });

  it('writes the signed-out snapshot when no server is signed in', async () => {
    stop = startCarSync();
    await settle();
    const snap = lastSnapshot();
    expect(snap.signedIn).toBe(false);
    expect(snap.labels.signedOut).toBe('Connect a server in AudioSilo to listen in the car');
    expect(snap.tabs.every((t) => t.items.length === 0)).toBe(true);
  });

  it('builds the four tabs from every server, the queue, the downloads and the library', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    connect(['c1', 'c2']);
    mockCaps.c1 = { queue: true, cover_sizes: true };
    mockClients.c1 = fakeClient({
      progress: [
        makeProgress({ path: 'P1', position: 3600, updated_at: '2026-02-01T00:00:00.000Z' }),
        makeProgress({ path: 'D', position: 130, duration: 200, updated_at: '2026-01-15' }),
      ],
      queue: [
        {
          library_id: 2,
          path: 'Q1',
          added_at: 'x',
          book: makeBook({ rel_path: 'Q1', title: 'Queued' }),
        },
      ],
      books: [makeBook({ rel_path: 'L1', title: 'Newest in library' })],
      items: { P1: makeBook({ rel_path: 'P1', title: 'Progressing' }) },
    });
    mockClients.c2 = fakeClient({
      progress: [
        makeProgress({ path: 'P2', position: 60, updated_at: '2026-03-01T00:00:00.000Z' }),
      ],
      items: { P2: makeBook({ rel_path: 'P2', title: 'On the other server' }) },
    });
    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });

    stop = startCarSync();
    await settle();
    const snap = lastSnapshot();
    expect(snap.signedIn).toBe(true);
    expect(snap.tabs.map((t) => t.id)).toEqual(['continue', 'upnext', 'downloads', 'library']);
    expect(snap.tabs.map((t) => t.title)).toEqual([
      'Continue listening',
      'Up next',
      'Downloads',
      'Library',
    ]);
    expect(tab(snap, 'continue')!.items.map((i) => i.title)).toEqual([
      'On the other server',
      'Progressing',
      'Downloaded D',
    ]);
    expect(tab(snap, 'upnext')!.items.map((i) => i.title)).toEqual(['Queued']);
    expect(tab(snap, 'library')!.items.map((i) => i.title)).toEqual(['Newest in library']);
    const d = tab(snap, 'downloads')!.items[0];
    expect(d).toMatchObject({
      id: carItemId({ connectionId: 'c1', libraryId: 2, path: 'D' }),
      book: { connectionId: 'c1', libraryId: 2, path: 'D' },
      downloaded: true,
    });
    // The downloaded book's play spec resumes where the listed server row says (through
    // the resume lookup), from its local files.
    expect(d.play).toMatchObject({ startIndex: 1, positionInTrack: 30 });
    expect(d.play!.tracks.map((t) => t.url)).toEqual(['file:///d/1.mp3', 'file:///d/2.mp3']);
    // Only the downloaded book has a play spec; no snapshot names a token or a URL.
    expect(tab(snap, 'library')!.items[0].play).toBeUndefined();
    expect(JSON.stringify(snap)).not.toMatch(/secret|https?:/);
    // The date is in it, and the body after it.
    const json = mockNative.setSnapshot.mock.calls[0][0];
    expect(json.startsWith('{"generatedAt":"')).toBe(true);
    expect(JSON.parse(json).version).toBe(1);
  });

  it('builds no play specs on iOS (CarPlay asks JS for every book)', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
    stop = startCarSync();
    await settle();
    expect(tab(lastSnapshot(), 'downloads')!.items[0].play).toBeUndefined();
    expect(mockReadLocalPlaces).not.toHaveBeenCalled();
    expect(playSpec).not.toHaveBeenCalled();
  });

  it("reads the device's own places once per build, and rebuilds a spec only when its inputs change", async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    connect(['c1']);
    mockClients.c1 = fakeClient({
      progress: [
        makeProgress({ path: 'D', position: 130, duration: 200, updated_at: '2026-01-15' }),
      ],
    });
    useDownloads.setState({
      entries: { 'c1:2:D': downloaded('c1', 'D'), 'c1:2:E': downloaded('c1', 'E') },
    });
    stop = startCarSync();
    await settle();
    expect(mockReadLocalPlaces).toHaveBeenCalledTimes(1);
    expect(playSpec).toHaveBeenCalledTimes(2);
    // Each spec says when its place was saved (FE-13): here the server row's.
    const d = tab(lastSnapshot(), 'downloads')!.items.find((i) => i.book.path === 'D')!;
    expect(d.play!.placeSavedAt).toBe(Date.parse('2026-01-15'));

    // E is played on this device: its newer save (the mirror) moves its spec; D's stands.
    mockReadLocalPlaces.mockClear();
    jest.mocked(playSpec).mockClear();
    mockLocalPlaces.mirror = {
      'c1:2:E': {
        connectionId: 'c1',
        libraryId: 2,
        path: 'E',
        position: 150,
        duration: 200,
        finished: false,
        playback_speed: 1.25,
        device_id: 'me',
        updated_at: '2026-02-01T00:00:00.000Z',
      },
    };
    mockNative.connection?.(true);
    await settle(MIN_GAP_MS);
    expect(mockReadLocalPlaces).toHaveBeenCalledTimes(1);
    expect(jest.mocked(playSpec).mock.calls.map((c) => c[0].path)).toEqual(['E']);
    const e = tab(lastSnapshot(), 'downloads')!.items.find((i) => i.book.path === 'E')!;
    expect(e.play).toMatchObject({ startIndex: 1, positionInTrack: 50, rate: 1.25 });
    expect(e.play!.placeSavedAt).toBe(Date.parse('2026-02-01T00:00:00.000Z'));

    // The server's clock skew, measured again at each sync answer: a jitter rebuilds nothing,
    // a real move rebuilds the specs it dates (D's, read by its server's clock).
    jest.mocked(playSpec).mockClear();
    mockLocalPlaces.skews = { c1: 400 };
    mockNative.connection?.(true);
    await settle(MIN_GAP_MS);
    expect(playSpec).not.toHaveBeenCalled();
    mockLocalPlaces.skews = { c1: 60_000 };
    mockNative.connection?.(true);
    await settle(MIN_GAP_MS);
    expect(
      jest
        .mocked(playSpec)
        .mock.calls.map((c) => c[0].path)
        .sort(),
    ).toEqual(['D', 'E']);
    const moved = tab(lastSnapshot(), 'downloads')!.items.find((i) => i.book.path === 'D')!;
    expect(moved.play!.placeSavedAt).toBe(Date.parse('2026-01-15') - 60_000);
  });

  it("rebuilds a downloaded book's spec when its chapters change (its files in a new order)", async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
    stop = startCarSync();
    await settle();
    const played = () => tab(lastSnapshot(), 'downloads')!.items[0].play!.tracks.map((t) => t.url);
    expect(played()).toEqual(['file:///d/1.mp3', 'file:///d/2.mp3']);

    // The server now plays them the other way round (`refreshedChapters`): same status.
    const reordered = downloaded('c1', 'D');
    reordered.manifest.chapters = {
      ...twoFileChapters,
      files: twoFileChapters.files.map((f) => ({ ...f, seq: 1 - f.seq })),
    };
    useDownloads.setState({ entries: { 'c1:2:D': reordered } });
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(played()).toEqual(['file:///d/2.mp3', 'file:///d/1.mp3']);
  });

  it('leaves Up next out where the default server keeps no queue', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle();
    expect(lastSnapshot().tabs.map((t) => t.id)).toEqual(['continue', 'downloads', 'library']);
  });

  it("lists the listener's library pick, and its server's first library when the pick is gone", async () => {
    connect(['c1', 'c2']);
    mockClients.c1 = fakeClient({ books: [makeBook({ rel_path: 'One' })] });
    mockClients.c2 = fakeClient({ books: [makeBook({ rel_path: 'Two' })] });
    useLibrarySelection.setState({ selection: { connectionId: 'c2', libraryId: 2 } });
    stop = startCarSync();
    await settle();
    expect(tab(lastSnapshot(), 'library')!.items.map((i) => i.book)).toEqual([
      { connectionId: 'c2', libraryId: 2, path: 'Two' },
    ]);
    expect(mockClients.c2.listBooks).toHaveBeenCalledWith(2, { sort: 'recent', limit: 50 });

    // A pick of a library its server no longer lists falls back, as the Library tab does:
    // to that server's first library, never another server's while it has one.
    useLibrarySelection.setState({ selection: { connectionId: 'c2', libraryId: 9 }, shown: null });
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(tab(lastSnapshot(), 'library')!.items.map((i) => i.book)).toEqual([
      { connectionId: 'c2', libraryId: 2, path: 'Two' },
    ]);
  });

  // The car has no picker and no state to show for a server: with no pick and the first
  // server unreadable, its Library tab stayed empty for the whole drive. It lists the
  // first server that could be read instead.
  it("with no pick, lists the first readable server's library when the first can't be read", async () => {
    connect(['c1', 'c2']);
    mockClients.c1 = fakeClient({ books: [makeBook({ rel_path: 'One' })] });
    (mockClients.c1.libraries as jest.Mock).mockRejectedValue(
      new TypeError('Network request failed'),
    );
    mockClients.c2 = fakeClient({ books: [makeBook({ rel_path: 'Two' })] });
    stop = startCarSync();
    await settle();
    expect(tab(lastSnapshot(), 'library')!.items.map((i) => i.book)).toEqual([
      { connectionId: 'c2', libraryId: 2, path: 'Two' },
    ]);
    expect(mockClients.c1.listBooks).not.toHaveBeenCalled();
  });

  // fe#142: a library the listener picked is never swapped for another server's because
  // its own server can't be read.
  it("never lists another server's library in place of the picked server's unread one", async () => {
    connect(['c1', 'c2']);
    mockClients.c1 = fakeClient({ books: [makeBook({ rel_path: 'One' })] });
    (mockClients.c1.libraries as jest.Mock).mockRejectedValue(
      new TypeError('Network request failed'),
    );
    (mockClients.c1.listBooks as jest.Mock).mockRejectedValue(
      new TypeError('Network request failed'),
    );
    mockClients.c2 = fakeClient({ books: [makeBook({ rel_path: 'Two' })] });
    useLibrarySelection.setState({ selection: { connectionId: 'c1', libraryId: 2 }, shown: null });
    stop = startCarSync();
    await settle();
    expect(tab(lastSnapshot(), 'library')?.items ?? []).toEqual([]);
    expect(mockClients.c2.listBooks).not.toHaveBeenCalled();
  });

  it('builds nothing until a car has connected on this device, then writes at once', async () => {
    await setItem('audiosilo.carSeen', false);
    connect(['c1']);
    mockCaps.c1 = { cover_sizes: true };
    mockClients.c1 = fakeClient({ books: [makeBook({ rel_path: 'L1', cover_version: 'v7' })] });
    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
    stop = startCarSync();
    await settle(SETTLE_MS + MIN_GAP_MS);
    useDownloads.setState({ entries: {} });
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(mockNative.setSnapshot).not.toHaveBeenCalled();
    expect(mockClients.c1.allProgress).not.toHaveBeenCalled();
    expect(ensureArtwork).not.toHaveBeenCalled();

    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
    mockNative.connection?.(true);
    await settle(0);
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(1);
    expect(await getItem('audiosilo.carSeen')).toBe(true);
    // A downloaded book's own cover; the others are fetched once the snapshot is out.
    expect(tab(lastSnapshot(), 'downloads')!.items[0].artwork).toBe('file:///d/cover.jpg');
    expect(tab(lastSnapshot(), 'library')!.items[0].artwork).toBeNull();
    expect(ensureArtwork).toHaveBeenCalledWith(
      'c1:2:L1#v7.jpg',
      'https://srv/cover?lib=2&path=L1&size=320&token=secret',
      undefined,
    );
    await settle(SETTLE_MS + MIN_GAP_MS);
    const snap = lastSnapshot();
    expect(tab(snap, 'library')!.items[0].artwork).toMatch(/^file:\/\/\/docs\/car-artwork\//);
    expect(JSON.stringify(snap)).not.toMatch(/secret|https?:/);
  });

  it('reads the artwork folder once per snapshot, for the checks and the prune', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({
      books: [makeBook({ rel_path: 'L1' }), makeBook({ rel_path: 'L2' })],
    });
    stop = startCarSync();
    await settle();
    expect(artworkOnDisk).toHaveBeenCalledTimes(1);
  });

  it('asks for the full cover from a server without thumbnails', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({ books: [makeBook({ rel_path: 'L1' })] });
    stop = startCarSync();
    await settle();
    expect(ensureArtwork).toHaveBeenCalledWith(
      'c1:2:L1#.jpg',
      'https://srv/cover?lib=2&path=L1&token=secret',
      undefined,
    );
  });

  it("fetches a cover with its connection's proxy headers for that address (fe#167)", async () => {
    connect(['c1']);
    const client = fakeClient({ books: [makeBook({ rel_path: 'L1' })] });
    const proxyHeadersFor = jest.fn((url: string) =>
      url.startsWith('https://srv/') ? { 'CF-Access-Client-Id': 'proxy-secret' } : undefined,
    );
    mockClients.c1 = { ...client, proxyHeadersFor };
    stop = startCarSync();
    await settle();
    expect(proxyHeadersFor).toHaveBeenCalledWith('https://srv/cover?lib=2&path=L1&token=secret');
    expect(ensureArtwork).toHaveBeenCalledWith(
      'c1:2:L1#.jpg',
      'https://srv/cover?lib=2&path=L1&token=secret',
      { 'CF-Access-Client-Id': 'proxy-secret' },
    );
    // Never in what native is handed.
    expect(JSON.stringify(lastSnapshot())).not.toMatch(/CF-Access|proxy-secret/);
  });

  it('writes again after a list changes, never closer than the gap, and not when nothing changed', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle();
    mockNative.connection?.(true); // a car is here: a book starting rebuilds at once
    await settle(MIN_GAP_MS);
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(1);

    // A queue refresh with the same content: built again, not sent again.
    mockCacheListener?.({
      type: 'updated',
      action: { type: 'success' },
      query: { queryKey: ['queue', 'c1'] },
    });
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(1);

    // A book finishes downloading: written once, after the settle.
    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
    useDownloads.setState({
      entries: { 'c1:2:D': downloaded('c1', 'D'), 'c1:2:E': downloaded('c1', 'E') },
    });
    await settle(SETTLE_MS - 100);
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(1);
    await settle(200);
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(2);

    // A download's progress tick (same states) asks for nothing.
    const build = mockClients.c1.allProgress.mock.calls.length;
    useDownloads.setState({
      entries: {
        'c1:2:D': downloaded('c1', 'D'),
        'c1:2:E': { ...downloaded('c1', 'E'), bytes: 5 },
      },
    });
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(mockClients.c1.allProgress.mock.calls.length).toBe(build);

    // A book starts right after: as soon as the gap allows, not before.
    await settle(MIN_GAP_MS);
    usePlayer.setState({
      nowPlaying: {
        connectionId: 'c1',
        libraryId: 2,
        path: 'D',
        queue: { offsets: [0, 100], total: 200 },
      },
      snapshot: { state: 'playing', trackIndex: 0, position: 5, duration: 100, rate: 1 },
    });
    await settle(0);
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(3);
  });

  it('rebuilds nothing on iOS for a book starting or pausing while no car is connected', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle();
    const builds = mockClients.c1.allProgress.mock.calls.length;
    usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'D', queue: { offsets: [0] } },
      snapshot: { state: 'playing', trackIndex: 0, position: 5, duration: 100, rate: 1 },
    });
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(mockClients.c1.allProgress.mock.calls.length).toBe(builds);

    // A car connecting builds a fresh one (it shows the book playing).
    mockNative.connection?.(true);
    await settle(MIN_GAP_MS);
    expect(tab(lastSnapshot(), 'continue')!.items[0].book.path).toBe('D');
  });

  it('refreshes at once when a car connects', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle();
    mockClients.c1.listBooks.mockResolvedValue({ books: [makeBook({ rel_path: 'New' })] });
    await settle(MIN_GAP_MS);
    // The cached list is still fresh: a connect re-reads only what has gone stale, so make
    // the change visible through the registry instead.
    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
    mockNative.connection?.(true);
    await settle(0);
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(2);
  });

  it("lists only the active profile's servers, and rebuilds at once on a switch", async () => {
    connect(['c1', 'c2']);
    mockClients.c1 = fakeClient({
      progress: [makeProgress({ path: 'P1', position: 60 })],
      items: { P1: makeBook({ rel_path: 'P1', title: "Chris's book" }) },
    });
    mockClients.c2 = fakeClient({
      progress: [makeProgress({ path: 'P2', position: 60 })],
      items: { P2: makeBook({ rel_path: 'P2', title: "Sam's book" }) },
    });
    useProfiles.setState({
      hydrated: true,
      profiles: [
        { id: 'chris', name: 'Chris', connectionIds: ['c1'] },
        { id: 'sam', name: 'Sam', connectionIds: ['c2'] },
      ],
      activeProfileId: 'chris',
    });
    stop = startCarSync();
    await settle();
    expect(tab(lastSnapshot(), 'continue')!.items.map((i) => i.title)).toEqual(["Chris's book"]);
    expect(mockClients.c2.allProgress).not.toHaveBeenCalled();
    await settle(MIN_GAP_MS);
    const writes = mockNative.setSnapshot.mock.calls.length;

    useProfiles.setState({ activeProfileId: 'sam' });
    // At once, as far as the gap after the last write allows (not after the settle).
    await settle(MIN_GAP_MS);
    expect(mockNative.setSnapshot.mock.calls.length).toBeGreaterThan(writes);
    expect(tab(lastSnapshot(), 'continue')!.items.map((i) => i.title)).toEqual(["Sam's book"]);
  });

  describe('a kids profile: the kids shelf only (Phase 8b-1)', () => {
    const ADAM = { id: 1, username: 'adam' };
    const coll = (id: number, name: string): Collection => ({
      id,
      name,
      description: '',
      owner: ADAM,
      owned: false,
      item_count: 0,
      preview: [],
      created_at: '',
      updated_at: '',
    });
    const detail = (c: Collection, paths: string[]): CollectionDetail => ({
      collection: c,
      items: paths.map((path) => ({
        library_id: 2,
        path,
        added_at: '',
        book: makeBook({ rel_path: path, title: `Story ${path}` }),
      })),
    });
    /** Chris (c1, a grown-up with a queue, a download and a library) and the kid (c2). */
    function household(kidUser: object, kids = true) {
      useSession.setState({
        status: 'authenticated',
        connections: [
          { id: 'c1', serverUrl: 'https://c1', name: 'c1', token: 's', user: {} },
          { id: 'c2', serverUrl: 'https://c1', name: 'c1', token: 's', user: kidUser },
        ] as Connection[],
        defaultConnectionId: 'c1',
      });
      mockCaps.c1 = { queue: true };
      mockCaps.c2 = { queue: true, collections: true };
      mockClients.c1 = fakeClient({
        progress: [makeProgress({ path: 'Grown', position: 60 })],
        items: { Grown: makeBook({ rel_path: 'Grown', title: "Chris's book" }) },
        books: [makeBook({ rel_path: 'Thriller', title: 'Thriller' })],
      });
      useDownloads.setState({
        entries: { 'c1:2:Mine': downloaded('c1', 'Mine'), 'c2:2:Kept': downloaded('c2', 'Kept') },
      });
      useProfiles.setState({
        hydrated: true,
        profiles: [
          { id: 'chris', name: 'Chris', connectionIds: ['c1'] },
          {
            id: 'evie',
            name: 'Evie',
            connectionIds: ['c2'],
            ...(kids ? { kids: { bedtime: '19:30' } } : {}),
          },
        ],
        activeProfileId: 'evie',
      });
    }

    it("a member's shared collections: Continue for its stories in progress, and Your stories", async () => {
      household({ id: 12, managed_by: ADAM, member_kind: 'kid' });
      const evies = coll(4, "Evie's books");
      const bedtime = coll(5, 'Bedtime');
      mockClients.c2 = fakeClient({
        progress: [
          makeProgress({ path: 'fox', position: 60 }),
          makeProgress({ path: 'Old', position: 60 }),
        ],
        collections: [evies, bedtime],
        details: { 4: detail(evies, ['moon', 'fox']), 5: detail(bedtime, ['owl', 'moon']) },
        queue: [{ library_id: 2, path: 'Q', added_at: 'x' }],
      });
      stop = startCarSync();
      await settle();
      const snap = lastSnapshot();
      expect(snap.tabs.map((t) => [t.id, t.title, t.items.map((i) => i.book.path)])).toEqual([
        ['continue', 'Continue listening', ['fox']],
        ['library', 'Your stories', ['fox', 'moon', 'owl']],
      ]);
      // Nothing of the grown-up's, no queue, no library page, no downloads tab.
      expect(JSON.stringify(snap)).not.toMatch(/Chris|Thriller|Mine|Kept|"Q"/);
      expect(mockClients.c2.listBooks).not.toHaveBeenCalled();
      expect(mockClients.c2.queue).not.toHaveBeenCalled();
      expect(mockClients.c1.allProgress).not.toHaveBeenCalled();
    });

    // Without the libraries a shared collection's episode can't be told from a story.
    it("a member's shared collections while the libraries can't be read: none listed", async () => {
      household({ id: 12, managed_by: ADAM, member_kind: 'kid' });
      const evies = coll(4, "Evie's books");
      mockClients.c2 = fakeClient({
        collections: [evies],
        details: { 4: detail(evies, ['moon', 'fox']) },
      });
      mockClients.c2.libraries.mockRejectedValue(new Error('down'));
      stop = startCarSync();
      await settle();
      const snap = lastSnapshot();
      expect(snap.tabs.map((t) => [t.id, t.items.map((i) => i.title)])).toEqual([
        ['library', ['Downloaded Kept']],
      ]);
      expect(mockClients.c2.collection).not.toHaveBeenCalled();
    });

    it('an account nobody manages (Phase 8): the one library, in its own order', async () => {
      household({ id: 12 });
      mockClients.c2 = fakeClient({
        books: [makeBook({ rel_path: 'a', title: 'A' }), makeBook({ rel_path: 'b', title: 'B' })],
      });
      stop = startCarSync();
      await settle();
      const snap = lastSnapshot();
      expect(snap.tabs.map((t) => [t.id, t.items.map((i) => i.title)])).toEqual([
        ['library', ['A', 'B']],
      ]);
      expect(mockClients.c2.collections).not.toHaveBeenCalled();
      // The library's own order (not the Library tab's recently added).
      expect(mockClients.c2.listBooks).toHaveBeenCalledWith(2, { limit: 50 });
    });

    it("offline with nothing cached: the stories downloaded on the kid's account", async () => {
      household({ id: 12, managed_by: ADAM, member_kind: 'kid' });
      mockClients.c2 = fakeClient({});
      mockClients.c2.allProgress.mockRejectedValue(new Error('offline'));
      mockClients.c2.collections.mockRejectedValue(new Error('offline'));
      stop = startCarSync();
      await settle();
      const snap = lastSnapshot();
      expect(snap.tabs.map((t) => [t.id, t.items.map((i) => i.title)])).toEqual([
        ['library', ['Downloaded Kept']],
      ]);
    });

    it("offline with its library known: only that library's downloads, never another library's", async () => {
      household({ id: 12 });
      mockClients.c2 = fakeClient({});
      mockClients.c2.libraries.mockResolvedValue([
        { id: 2, name: 'Kids' },
        { id: 3, name: 'Grown-ups' },
      ]);
      // The library is known, its page can't be read.
      mockClients.c2.listBooks.mockRejectedValue(new Error('offline'));
      useDownloads.setState({
        entries: {
          'c2:2:Kept': downloaded('c2', 'Kept'),
          'c2:3:Thriller': { ...downloaded('c2', 'Thriller'), libraryId: 3 },
        },
      });
      stop = startCarSync();
      await settle();
      expect(tab(lastSnapshot(), 'library')!.items.map((i) => i.title)).toEqual([
        'Downloaded Kept',
      ]);
    });

    it("rebuilds for a story read anew in the kid's shared collection, never another server's or the same answer", async () => {
      household({ id: 12, managed_by: ADAM, member_kind: 'kid' });
      const evies = coll(4, "Evie's books");
      mockClients.c2 = fakeClient({
        collections: [evies],
        details: { 4: detail(evies, ['moon']) },
      });
      stop = startCarSync();
      await settle();
      await settle(MIN_GAP_MS);
      // Every build reads the kid's collections (the fake reads skip the cache).
      const builds = () => mockClients.c2.collections.mock.calls.length;
      const before = builds();
      const answered = (queryKey: unknown[], data: unknown) =>
        mockCacheListener?.({
          type: 'updated',
          action: { type: 'success' },
          query: { queryKey, queryHash: JSON.stringify(queryKey), state: { data } },
        });
      const moon = detail(evies, ['moon']);
      // Another server's collection: not the kids shelf.
      answered(['collection', 'c1', 4], moon);
      await settle(SETTLE_MS + MIN_GAP_MS);
      expect(builds()).toBe(before);
      answered(['collection', 'c2', 4], moon);
      await settle(SETTLE_MS + MIN_GAP_MS);
      expect(builds()).toBe(before + 1);
      // The same answer read again (the cache keeps the same data): nothing new.
      answered(['collection', 'c2', 4], moon);
      await settle(SETTLE_MS + MIN_GAP_MS);
      expect(builds()).toBe(before + 1);
      answered(['collection', 'c2', 4], detail(evies, ['moon', 'fox']));
      await settle(SETTLE_MS + MIN_GAP_MS);
      expect(builds()).toBe(before + 2);
    });

    it('reads the shelf alongside the progress, not after it', async () => {
      household({ id: 12, managed_by: ADAM, member_kind: 'kid' });
      const evies = coll(4, "Evie's books");
      mockClients.c2 = fakeClient({
        collections: [evies],
        details: { 4: detail(evies, ['moon']) },
      });
      let answerProgress: (rows: Progress[]) => void = () => undefined;
      mockClients.c2.allProgress.mockImplementationOnce(
        () => new Promise<Progress[]>((r) => (answerProgress = r)),
      );
      stop = startCarSync();
      await settle();
      // The progress is still on its way: the collections and their stories are read.
      expect(mockClients.c2.collections).toHaveBeenCalled();
      expect(mockClients.c2.collection).toHaveBeenCalledWith(4, undefined);
      expect(mockClients.c2.libraries).toHaveBeenCalled();
      answerProgress([]);
      await settle();
      expect(tab(lastSnapshot(), 'library')!.items.map((i) => i.book.path)).toEqual(['moon']);
    });

    it('kids mode turned on for the person listening rebuilds at once', async () => {
      household({ id: 12 }, false);
      mockClients.c2 = fakeClient({ books: [makeBook({ rel_path: 'a', title: 'A' })] });
      stop = startCarSync();
      await settle();
      expect(lastSnapshot().tabs.map((t) => t.id)).toEqual([
        'continue',
        'upnext',
        'downloads',
        'library',
      ]);
      await settle(MIN_GAP_MS);
      useProfiles.setState({
        profiles: useProfiles
          .getState()
          .profiles.map((p) => (p.id === 'evie' ? { ...p, kids: { bedtime: '19:30' } } : p)),
      });
      await settle(MIN_GAP_MS);
      expect(lastSnapshot().tabs.map((t) => [t.id, t.title])).toEqual([
        ['library', 'Your stories'],
      ]);
    });
  });

  it("lists only the active profile's downloads (no play spec for another person's)", async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    connect(['c1', 'c2']);
    mockClients.c1 = fakeClient({});
    mockClients.c2 = fakeClient({});
    useDownloads.setState({
      entries: { 'c1:2:Mine': downloaded('c1', 'Mine'), 'c2:2:Theirs': downloaded('c2', 'Theirs') },
    });
    useProfiles.setState({
      hydrated: true,
      profiles: [
        { id: 'sam', name: 'Sam', connectionIds: ['c1'] },
        { id: 'alex', name: 'Alex', connectionIds: ['c2'], hasPin: true },
      ],
      activeProfileId: 'sam',
    });
    stop = startCarSync();
    await settle();
    const snap = lastSnapshot();
    expect(tab(snap, 'downloads')!.items.map((i) => i.title)).toEqual(['Downloaded Mine']);
    expect(JSON.stringify(snap)).not.toContain('Theirs');
  });

  it('runs the connect path once for a car connected before it started (CarPlay-first: the iOS car start heard the queued connect)', async () => {
    await setItem('audiosilo.carSeen', false);
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    // The iOS car start's listener, the first, recorded the connect native queued before JS
    // listened; the sync's own listener never hears that one.
    setCarConnected(true);
    stop = startCarSync();
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(await getItem('audiosilo.carSeen')).toBe(true);
    // One write for one connect (the catch-up and the start's own request join).
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(1);
    // A second start (the root layout) catches up on nothing: the sync is already running.
    const again = startCarSync();
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(1);
    again();
  });

  it('handles a connect once while it runs, also when the iOS car start recorded it too', async () => {
    await setItem('audiosilo.carSeen', false);
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(mockNative.setSnapshot).not.toHaveBeenCalled(); // no car met yet

    setCarConnected(true); // the iOS car start's listener, first
    mockNative.connection?.(true); // the sync's own
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(isCarConnected()).toBe(true);
    expect(await getItem('audiosilo.carSeen')).toBe(true);
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(1);
    mockNative.connection?.(false);
    expect(isCarConnected()).toBe(false);
  });

  it('is shared: a second start adds no listeners, and the last stop removes them', async () => {
    const a = startCarSync();
    const b = startCarSync();
    expect(mockNative.onConnection).toHaveBeenCalledTimes(1);
    a();
    expect(mockNative.connection).not.toBeNull();
    b();
    expect(mockNative.connection).toBeNull();
  });
});

describe('the resumable snapshot (Android, fe#251)', () => {
  const loaded = (state: string, trackIndex: number, position: number) => ({
    nowPlaying: {
      connectionId: 'c1',
      libraryId: 2,
      path: 'D',
      queue: { offsets: [0, 100], total: 200 },
    },
    snapshot: { state, trackIndex, position, duration: 100, rate: 1.5 },
    rate: 1.5,
  });

  /** Promise turns only: no timer runs (Android holds the JS timers in the background). */
  async function flushPromises() {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  }

  beforeEach(async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    await setItem('audiosilo.carSeen', false);
    connect(['c1']);
    mockClients.c1 = fakeClient({ books: [makeBook({ rel_path: 'L1' })] });
    useDownloads.setState({
      entries: { 'c1:2:D': downloaded('c1', 'D'), 'c1:2:E': downloaded('c1', 'E') },
    });
  });

  it('is written on a pause with no car ever met, at the paused place, with no timer and no server read', async () => {
    usePlayer.setState(loaded('playing', 1, 20));
    stop = startCarSync();
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(mockNative.setSnapshot).not.toHaveBeenCalled(); // playing on: nothing to write

    usePlayer.setState(loaded('paused', 1, 30));
    await flushPromises();
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(1);
    const snap = lastSnapshot();
    expect(snap.signedIn).toBe(true);
    expect(snap.tabs.map((t) => t.id)).toEqual(['continue', 'downloads']);
    // What a resumption plays (`CarSnapshot.resumable`): the paused book, from where it paused.
    const first = tab(snap, 'continue')!.items[0];
    expect(first.book).toEqual({ connectionId: 'c1', libraryId: 2, path: 'D' });
    expect(snap.resume).toBe(first.id);
    expect(first.play).toMatchObject({ startIndex: 1, positionInTrack: 30, rate: 1.5 });
    expect(first.artwork).toBe('file:///d/cover.jpg');
    expect(
      tab(snap, 'downloads')!
        .items.map((i) => i.book.path)
        .sort(),
    ).toEqual(['D', 'E']);
    // Nothing read from a server, no cover fetched or pruned, and no car remembered.
    expect(mockClients.c1.allProgress).not.toHaveBeenCalled();
    expect(mockClients.c1.listBooks).not.toHaveBeenCalled();
    expect(ensureArtwork).not.toHaveBeenCalled();
    expect(pruneArtwork).not.toHaveBeenCalled();
    expect(await getItem('audiosilo.carSeen')).toBe(false);
    expect(JSON.stringify(snap)).not.toMatch(/secret|https?:/);
  });

  it('leaves nothing to resume once the book is stopped', async () => {
    stop = startCarSync();
    await settle();
    usePlayer.setState(loaded('paused', 0, 10));
    await flushPromises();
    expect(tab(lastSnapshot(), 'continue')!.items).toHaveLength(1);

    usePlayer.setState({
      nowPlaying: null,
      snapshot: { state: 'idle', trackIndex: 0, position: 0, duration: 0, rate: 1 },
    });
    await flushPromises();
    expect(tab(lastSnapshot(), 'continue')!.items).toEqual([]);
    expect(lastSnapshot().resume).toBeNull();
  });

  it('is written again for another person, so their book is never resumed', async () => {
    stop = startCarSync();
    await settle();
    usePlayer.setState(loaded('paused', 0, 10));
    await flushPromises();
    expect(lastSnapshot().signedIn).toBe(true);

    connect([]);
    await flushPromises();
    expect(lastSnapshot().signedIn).toBe(false);
    expect(lastSnapshot().tabs.every((t) => t.items.length === 0)).toBe(true);
  });

  it('is not written on iOS (CarPlay has no resumption)', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    stop = startCarSync();
    await settle();
    usePlayer.setState(loaded('playing', 1, 20));
    usePlayer.setState(loaded('paused', 1, 30));
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(mockNative.setSnapshot).not.toHaveBeenCalled();
  });

  it('offers the book a pause offered before on a launch that loads none (after a kill)', async () => {
    await setItem('audiosilo.carResumable', { connectionId: 'c1', libraryId: 2, path: 'D' });
    mockLocalPlaces.mirror = {
      'c1:2:D': {
        connectionId: 'c1',
        libraryId: 2,
        path: 'D',
        position: 130,
        duration: 200,
        finished: false,
        playback_speed: 1,
        device_id: 'me',
        updated_at: '2026-02-01T00:00:00.000Z',
      },
    };
    stop = startCarSync();
    await settle();
    // The launch hydrates the downloads: written again, still offering that book.
    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
    await flushPromises();
    const first = tab(lastSnapshot(), 'continue')!.items[0];
    expect(first.book).toEqual({ connectionId: 'c1', libraryId: 2, path: 'D' });
    expect(first.play).toMatchObject({ startIndex: 1, positionInTrack: 30 });

    // Once a book was loaded and stopped here, nothing is offered, after a launch too.
    usePlayer.setState(loaded('paused', 0, 10));
    usePlayer.setState({
      nowPlaying: null,
      snapshot: { state: 'idle', trackIndex: 0, position: 0, duration: 0, rate: 1 },
    });
    await flushPromises();
    expect(tab(lastSnapshot(), 'continue')!.items).toEqual([]);
    expect(await getItem('audiosilo.carResumable')).toBeNull();
  });

  // fe#350: a headset's play after a kill starts with the labels, speed and chapters the
  // listener has now.
  it('is written again on a language, speed or chapter interval change', async () => {
    const settings = useSettings.getState();
    stop = startCarSync();
    await settle();
    usePlayer.setState(loaded('paused', 1, 30));
    await flushPromises();
    const writes = () => mockNative.setSnapshot.mock.calls.length;
    const before = writes();
    try {
      await ensureLanguage('de');
      await i18n.changeLanguage('de');
      await flushPromises();
      expect(writes()).toBe(before + 1);
      expect(lastSnapshot().labels.unavailable).toBe(
        'Dieses Buch kann gerade nicht abgespielt werden',
      );

      // E (not the paused book) starts at the default speed.
      useSettings.setState({ defaultRate: 1.75 });
      await flushPromises();
      expect(writes()).toBe(before + 2);
      const e = tab(lastSnapshot(), 'downloads')!.items.find((i) => i.book.path === 'E')!;
      expect(e.play!.rate).toBe(1.75);

      jest.mocked(playSpec).mockClear();
      useSettings.setState({ virtualChapterInterval: settings.virtualChapterInterval + 600 });
      await flushPromises();
      expect(jest.mocked(playSpec).mock.calls.map((c) => c[4])).toContain(
        settings.virtualChapterInterval + 600,
      );
    } finally {
      await i18n.changeLanguage('en');
      useSettings.setState({
        defaultRate: settings.defaultRate,
        virtualChapterInterval: settings.virtualChapterInterval,
      });
    }
  });

  // fe#350: native refused the write, so it still holds the book it had: nothing keeps the
  // new one for the next launch.
  it('keeps no book for the next launch when native refuses the write', async () => {
    stop = startCarSync();
    await settle();
    mockNative.setSnapshot.mockResolvedValueOnce(false);
    usePlayer.setState(loaded('paused', 1, 30));
    await flushPromises();
    expect(await getItem('audiosilo.carResumable')).toBeNull();
    // The next write lands, and the book is kept.
    usePlayer.setState(loaded('paused', 0, 40));
    await flushPromises();
    expect(await getItem('audiosilo.carResumable')).toMatchObject({ path: 'D' });
  });

  it('is written again when the paused book moves, at its new place', async () => {
    stop = startCarSync();
    await settle();
    usePlayer.setState(loaded('paused', 1, 30));
    await flushPromises();
    usePlayer.setState(loaded('paused', 0, 40));
    await flushPromises();
    expect(tab(lastSnapshot(), 'continue')!.items[0].play).toMatchObject({
      startIndex: 0,
      positionInTrack: 40,
    });
  });

  it('never writes over a car-seen phone at launch, before its car-seen mark was read', async () => {
    await setItem('audiosilo.carSeen', true);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const read = storage.getItem;
    const slow = jest.spyOn(storage, 'getItem').mockImplementation(async (key: string) => {
      if (key === 'audiosilo.carSeen') await held;
      return read(key);
    });
    try {
      stop = startCarSync();
      connect(['c1']); // the launch hydrates the session meanwhile
      await flushPromises();
      release();
      await flushPromises();
    } finally {
      slow.mockRestore();
    }
    // The full snapshot is due on its timer; the resumable one never went over it.
    expect(mockNative.setSnapshot).not.toHaveBeenCalled();
  });

  it('with a car met before but none connected, a pause writes the full snapshot at once, from the cache', async () => {
    const cache = queryClient.getQueryData as jest.Mock;
    await setItem('audiosilo.carSeen', true);
    usePlayer.setState(loaded('playing', 1, 20));
    stop = startCarSync();
    await settle(SETTLE_MS + MIN_GAP_MS);
    const writes = mockNative.setSnapshot.mock.calls.length;
    const reads = mockClients.c1.allProgress.mock.calls.length;
    cache.mockImplementation(() => []);

    usePlayer.setState(loaded('paused', 1, 50));
    await flushPromises(); // no timer runs
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(writes + 1);
    expect(mockClients.c1.allProgress).toHaveBeenCalledTimes(reads);
    expect(tab(lastSnapshot(), 'continue')!.items[0].play).toMatchObject({
      startIndex: 1,
      positionInTrack: 50,
    });
    cache.mockImplementation(() => undefined);
  });

  it('with a car met before but none connected, a pause writes the full snapshot at the paused place', async () => {
    await setItem('audiosilo.carSeen', true);
    mockClients.c1 = fakeClient({
      progress: [
        makeProgress({ path: 'D', position: 130, duration: 200, updated_at: '2026-01-15' }),
      ],
    });
    usePlayer.setState(loaded('playing', 1, 20));
    stop = startCarSync();
    await settle(SETTLE_MS + MIN_GAP_MS);
    const writes = mockNative.setSnapshot.mock.calls.length;

    const pausedAt = Date.now();
    usePlayer.setState(loaded('paused', 1, 50));
    await settle(MIN_GAP_MS);
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(writes + 1);
    const snap = lastSnapshot();
    expect(snap.tabs.map((t) => t.id)).toEqual(['continue', 'downloads', 'library']);
    // The paused place (150 s), not the server row's 130 s the device save has not passed yet.
    expect(tab(snap, 'continue')!.items[0].play).toMatchObject({
      startIndex: 1,
      positionInTrack: 50,
    });
    // Saved as it was written (FE-13): newer than the live place a dead process left.
    expect(tab(snap, 'continue')!.items[0].play!.placeSavedAt).toBeGreaterThanOrEqual(pausedAt);
  });

  it("is not the snapshot an unreadable build keeps: the first car's is written offline too", async () => {
    const offline = new TypeError('Network request failed');
    mockClients.c1.allProgress.mockRejectedValue(offline);
    mockClients.c1.queue.mockRejectedValue(offline);
    mockClients.c1.libraries.mockRejectedValue(offline);
    mockClients.c1.listBooks.mockRejectedValue(offline);
    stop = startCarSync();
    await settle();
    usePlayer.setState(loaded('paused', 1, 30));
    await flushPromises();
    expect(lastSnapshot().tabs.map((t) => t.id)).toEqual(['continue', 'downloads']);
    expect(await getItem('audiosilo.carSnapshotWritten')).not.toBe(true);

    // The first car, away from the server: its own snapshot, not the minimal one kept.
    mockNative.connection?.(true);
    await settle(MIN_GAP_MS);
    expect(lastSnapshot().tabs.map((t) => t.id)).toContain('library');
    expect(await getItem('audiosilo.carSnapshotWritten')).toBe(true);
  });

  it('a pause while a snapshot is being written is written right after it, with no timer', async () => {
    await setItem('audiosilo.carSeen', true);
    usePlayer.setState(loaded('playing', 1, 20));
    let answer = (_rows: Progress[]) => {};
    mockClients.c1.allProgress.mockImplementationOnce(
      () => new Promise<Progress[]>((resolve) => (answer = resolve)),
    );
    stop = startCarSync();
    await settle(MIN_GAP_MS); // the launch's build is reading the server
    expect(mockNative.setSnapshot).not.toHaveBeenCalled();

    usePlayer.setState(loaded('paused', 1, 50));
    await flushPromises();
    answer([]);
    await flushPromises(); // no timer runs: the launch's write,
    await flushPromises(); // then the pause's
    expect(tab(lastSnapshot(), 'continue')!.items[0].play).toMatchObject({
      startIndex: 1,
      positionInTrack: 50,
    });
  });

  it("a resumption's write never holds back the build of a car that connects right after", async () => {
    await setItem('audiosilo.carSeen', true);
    usePlayer.setState(loaded('playing', 1, 20));
    stop = startCarSync();
    await settle(SETTLE_MS + MIN_GAP_MS);

    usePlayer.setState(loaded('paused', 1, 50));
    await flushPromises();
    const reads = mockClients.c1.allProgress.mock.calls.length;

    // No car saw that write: the connect's fresh build does not wait `MIN_GAP_MS` after it.
    mockNative.connection?.(true);
    await settle();
    expect(mockClients.c1.allProgress.mock.calls.length).toBeGreaterThan(reads);
  });

  describe('the book a resumption starts, on a phone that met a car', () => {
    const D = carItemId({ connectionId: 'c1', libraryId: 2, path: 'D' });
    const stopped = {
      nowPlaying: null,
      snapshot: { state: 'idle', trackIndex: 0, position: 0, duration: 0, rate: 1 },
    };

    beforeEach(async () => {
      await setItem('audiosilo.carSeen', true);
      // D is the newest book in progress, and downloaded: the first Continue listening row
      // has a play spec whether or not it is loaded.
      mockClients.c1 = fakeClient({
        progress: [
          makeProgress({ path: 'D', position: 130, duration: 200, updated_at: '2026-01-15' }),
        ],
      });
    });

    it('is the paused book, and none once it is stopped: the newest book in progress stays stopped', async () => {
      usePlayer.setState(loaded('playing', 1, 20));
      stop = startCarSync();
      await settle(SETTLE_MS + MIN_GAP_MS);
      usePlayer.setState(loaded('paused', 1, 50));
      await flushPromises();
      expect(lastSnapshot().resume).toBe(D);

      usePlayer.setState(stopped);
      await flushPromises();
      const snap = lastSnapshot();
      // Still listed first, still startable from the car, but not what a headset's play starts.
      expect(tab(snap, 'continue')!.items[0]).toMatchObject({ id: D, play: expect.anything() });
      expect(snap.resume).toBeNull();
      expect(await getItem('audiosilo.carResumable')).toBeNull();
    });

    it('is none once the book finished', async () => {
      usePlayer.setState(loaded('playing', 1, 20));
      stop = startCarSync();
      await settle(SETTLE_MS + MIN_GAP_MS);
      usePlayer.setState(loaded('ended', 1, 100));
      await flushPromises();
      expect(lastSnapshot().resume).toBeNull();
    });

    it('is the book a pause offered before on a launch that loads none (after a kill)', async () => {
      await setItem('audiosilo.carResumable', { connectionId: 'c1', libraryId: 2, path: 'E' });
      stop = startCarSync();
      await settle(SETTLE_MS + MIN_GAP_MS);
      const snap = lastSnapshot();
      // Not the newest book in progress (D): the one that was paused (E, among the downloads).
      expect(tab(snap, 'continue')!.items[0].id).toBe(D);
      expect(snap.resume).toBe(carItemId({ connectionId: 'c1', libraryId: 2, path: 'E' }));
    });

    // FE-ANDROID-3: the car's book plays on, never adopted, and the store's book showed
    // paused at the adoption deadline: a resumption plays the book that was heard.
    it("is the engine's book while it plays another book than the store's, not adopted", async () => {
      usePlayer.setState(loaded('playing', 1, 20));
      stop = startCarSync();
      await settle(SETTLE_MS + MIN_GAP_MS);
      // The engine plays E (the car's tap); the deadline shows D paused.
      mockEngineOther = { connectionId: 'c1', libraryId: 2, path: 'E' };
      usePlayer.setState(loaded('paused', 1, 50));
      await flushPromises();
      const E = carItemId({ connectionId: 'c1', libraryId: 2, path: 'E' });
      const snap = lastSnapshot();
      expect(snap.resume).toBe(E);
      // Listed with its play spec (the downloads), so native can start it.
      expect(tab(snap, 'downloads')!.items.find((i) => i.id === E)?.play).toBeTruthy();
      expect(await getItem('audiosilo.carResumable')).toMatchObject({ path: 'E' });

      // Adopted, or the store's own book heard again: the loaded book is named once more.
      mockEngineOther = null;
      usePlayer.setState(loaded('paused', 1, 60));
      await flushPromises();
      expect(lastSnapshot().resume).toBe(D);
    });

    // The car's book played to its end with no change of the store's to say so: the snapshot
    // that named it is written again (native drops its live place at the end, so the named
    // book is the one a headset's play after a kill starts), and nothing is adopted.
    it("names the loaded book again once the engine's other book played to its end", async () => {
      usePlayer.setState(loaded('playing', 1, 20));
      stop = startCarSync();
      await settle(SETTLE_MS + MIN_GAP_MS);
      mockEngineOther = { connectionId: 'c1', libraryId: 2, path: 'E' };
      usePlayer.setState(loaded('paused', 1, 50));
      await flushPromises();
      expect(lastSnapshot().resume).toBe(
        carItemId({ connectionId: 'c1', libraryId: 2, path: 'E' }),
      );
      mockNative.getLoadedBook.mockClear();
      // E ended (`engineOtherBook` names none from then): the store is unchanged.
      mockEngineOther = null;
      mockOtherBookReported?.('ended');
      await flushPromises();
      expect(lastSnapshot().resume).toBe(D);
      expect(await getItem('audiosilo.carResumable')).toMatchObject({ path: 'D' });
      expect(mockNative.getLoadedBook).not.toHaveBeenCalled();
    });

    // The review: the store's book was paused already when the car's book began playing, so
    // nothing of the store's changed and no snapshot named the car's book; one the adoption
    // gave up on was never resumed by a headset's play after a kill.
    it("names the engine's book once it begins playing, the store's book paused", async () => {
      usePlayer.setState(loaded('paused', 1, 50));
      stop = startCarSync();
      await settle(SETTLE_MS + MIN_GAP_MS);
      expect(lastSnapshot().resume).toBe(D);
      mockNative.getLoadedBook.mockClear();
      mockEngineOther = { connectionId: 'c1', libraryId: 2, path: 'E' };
      mockOtherBookReported?.('playing');
      await flushPromises();
      const E = carItemId({ connectionId: 'c1', libraryId: 2, path: 'E' });
      expect(lastSnapshot().resume).toBe(E);
      expect(await getItem('audiosilo.carResumable')).toMatchObject({ path: 'E' });
      // Its adoption is still asked for (the engine is read).
      expect(mockNative.getLoadedBook).toHaveBeenCalled();
    });

    it("names the engine's book once it begins playing, the store's book finished", async () => {
      usePlayer.setState(loaded('ended', 1, 100));
      stop = startCarSync();
      await settle(SETTLE_MS + MIN_GAP_MS);
      expect(lastSnapshot().resume).toBeNull();
      mockEngineOther = { connectionId: 'c1', libraryId: 2, path: 'E' };
      mockOtherBookReported?.('playing');
      await flushPromises();
      expect(lastSnapshot().resume).toBe(
        carItemId({ connectionId: 'c1', libraryId: 2, path: 'E' }),
      );
    });

    it("never names the engine's book when it is not the person listening's", async () => {
      connect(['c1', 'c2']);
      mockClients.c2 = fakeClient({});
      useProfiles.setState({
        hydrated: true,
        profiles: [
          { id: 'sam', name: 'Sam', connectionIds: ['c1'] },
          { id: 'alex', name: 'Alex', connectionIds: ['c2'], hasPin: true },
        ],
        activeProfileId: 'sam',
      });
      usePlayer.setState(loaded('playing', 1, 20));
      stop = startCarSync();
      await settle(SETTLE_MS + MIN_GAP_MS);
      mockEngineOther = { connectionId: 'c2', libraryId: 2, path: 'E' };
      usePlayer.setState(loaded('paused', 1, 50));
      await flushPromises();
      expect(lastSnapshot().resume).toBe(D);
    });

    it('is not named on iOS (CarPlay has no resumption)', async () => {
      Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
      usePlayer.setState(loaded('paused', 1, 50));
      stop = startCarSync();
      await settle(SETTLE_MS + MIN_GAP_MS);
      expect(lastSnapshot()).not.toHaveProperty('resume');
    });
  });

  it('never offers a kids profile the book offered before kids mode was turned on', async () => {
    useProfiles.setState({
      hydrated: true,
      profiles: [{ id: 'p', name: 'P', connectionIds: ['c1'] }],
      activeProfileId: 'p',
    });
    await setItem('audiosilo.carResumable', {
      connectionId: 'c1',
      libraryId: 2,
      path: 'D',
      kids: false,
    });
    stop = startCarSync();
    await settle();
    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
    await flushPromises();
    expect(tab(lastSnapshot(), 'continue')!.items).toHaveLength(1);

    // Kids mode on, no book loaded since the launch: that book may not be on the kids shelf.
    useProfiles.setState({
      profiles: [{ id: 'p', name: 'P', connectionIds: ['c1'], kids: { bedtime: '19:30' } }],
    });
    await flushPromises();
    const snap = lastSnapshot();
    expect(tab(snap, 'continue')!.items).toEqual([]);
    expect(snap.resume).toBeNull();
    expect(await getItem('audiosilo.carResumable')).toBeNull();
  });
});

describe("the car's Library tab with no pick (D9, fe#271)", () => {
  it('keeps the server it listed for the drive when the first server answers later', async () => {
    connect(['c1', 'c2']);
    mockClients.c1 = fakeClient({ books: [makeBook({ rel_path: 'One' })] });
    (mockClients.c1.libraries as jest.Mock).mockRejectedValueOnce(
      new TypeError('Network request failed'),
    );
    mockClients.c2 = fakeClient({ books: [makeBook({ rel_path: 'Two' })] });
    stop = startCarSync();
    mockNative.connection?.(true);
    await settle(MIN_GAP_MS);
    const listed = () => tab(lastSnapshot(), 'library')!.items.map((i) => i.book.path);
    expect(listed()).toEqual(['Two']);

    // The first server answers mid-drive: the tab stays on the second's library.
    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect((mockClients.c1.libraries as jest.Mock).mock.calls.length).toBeGreaterThan(1);
    expect(tab(lastSnapshot(), 'downloads')!.items).toHaveLength(1);
    expect(listed()).toEqual(['Two']);

    // The next drive starts afresh: the first server's library.
    mockNative.connection?.(false);
    mockNative.connection?.(true);
    await settle(MIN_GAP_MS);
    expect(listed()).toEqual(['One']);
  });

  it('forgets the library it listed when another person takes over mid-drive', async () => {
    connect(['c1', 'c2']);
    useProfiles.setState({
      hydrated: true,
      profiles: [
        { id: 'chris', name: 'Chris', connectionIds: ['c1', 'c2'] },
        { id: 'sam', name: 'Sam', connectionIds: ['c1', 'c2'] },
      ],
      activeProfileId: 'chris',
    });
    mockClients.c1 = fakeClient({ books: [makeBook({ rel_path: 'One' })] });
    (mockClients.c1.libraries as jest.Mock).mockRejectedValueOnce(
      new TypeError('Network request failed'),
    );
    mockClients.c2 = fakeClient({ books: [makeBook({ rel_path: 'Two' })] });
    stop = startCarSync();
    mockNative.connection?.(true);
    await settle(MIN_GAP_MS);
    const listed = () => tab(lastSnapshot(), 'library')!.items.map((i) => i.book.path);
    expect(listed()).toEqual(['Two']);

    // Sam's lists start afresh: the first server, which answers now.
    useProfiles.setState({ activeProfileId: 'sam' });
    await settle(MIN_GAP_MS);
    expect(listed()).toEqual(['One']);
  });
});

describe('play requests', () => {
  const ref = { connectionId: 'c1', libraryId: 2, path: 'Some: book.m4b' };

  it('starts the book from its saved place through startBookInPlace', async () => {
    stop = startCarSync();
    mockNative.playRequest?.(carItemId(ref));
    await settle();
    expect(mockStartBookInPlace).toHaveBeenCalledWith(ref, {}, carStart);
  });

  it('plays the loaded book on instead of restarting it', async () => {
    usePlayer.setState({
      nowPlaying: { ...ref, queue: { offsets: [0], total: 100 } },
      snapshot: { state: 'paused', trackIndex: 0, position: 40, duration: 100, rate: 1 },
    });
    await handleCarPlayRequest(carItemId(ref));
    expect(usePlayer.getState().toggle).toHaveBeenCalled();
    expect(mockStartBookInPlace).not.toHaveBeenCalled();

    usePlayer.getState().toggle.mockClear();
    usePlayer.setState({
      snapshot: { state: 'playing', trackIndex: 0, position: 40, duration: 100, rate: 1 },
    });
    await handleCarPlayRequest(carItemId(ref));
    expect(usePlayer.getState().toggle).not.toHaveBeenCalled();
    expect(mockStartBookInPlace).not.toHaveBeenCalled();
  });

  it('starts an ended loaded book again through the resume lookup', async () => {
    usePlayer.setState({
      nowPlaying: { ...ref, queue: { offsets: [0], total: 100 } },
      snapshot: { state: 'ended', trackIndex: 0, position: 100, duration: 100, rate: 1 },
    });
    await handleCarPlayRequest(carItemId(ref));
    expect(mockStartBookInPlace).toHaveBeenCalledWith(ref, {}, carStart);
  });

  it('an item of a snapshot from before the identity migration starts the book on its new connection', async () => {
    // The aliases load in the launch steps, which a tap queued while JS booted waits for.
    jest.mocked(bootstrapPlayback).mockImplementationOnce(async () => {
      setConnectionAliases({ srv: 'srv.3' });
    });
    try {
      await handleCarPlayRequest(carItemId({ ...ref, connectionId: 'srv' }));
      expect(mockStartBookInPlace).toHaveBeenCalledWith(
        { ...ref, connectionId: 'srv.3' },
        {},
        carStart,
      );
    } finally {
      setConnectionAliases({});
    }
  });

  it("leaves another person's book to the start, which refuses it (an older snapshot's item)", async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    useProfiles.setState({
      hydrated: true,
      profiles: [
        { id: 'sam', name: 'Sam', connectionIds: ['c2'] },
        { id: 'alex', name: 'Alex', connectionIds: ['c1'], hasPin: true },
      ],
      activeProfileId: 'sam',
    });
    // `startBookInPlace` holds the rule (`mayActFor`, tested with it): the car keeps no copy.
    mockStartBookInPlace.mockResolvedValueOnce(false);
    await handleCarPlayRequest(carItemId(ref));
    expect(mockStartBookInPlace).toHaveBeenCalledWith(ref, {}, carStart);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("another person's"));
    warn.mockRestore();
  });

  it('finding 9: casting, a play from the car ends the cast first and plays in the car', async () => {
    const order: string[] = [];
    mockEndCastForCar.mockImplementationOnce(async () => {
      order.push('end cast');
      // The book came back here, paused at the receiver's place.
      usePlayer.setState({
        nowPlaying: { ...ref, queue: { offsets: [0], total: 100 } },
        snapshot: { state: 'paused', trackIndex: 0, position: 70, duration: 100, rate: 1 },
      });
      return true;
    });
    usePlayer.getState().toggle.mockImplementationOnce(async () => {
      order.push('play');
    });
    await handleCarPlayRequest(carItemId(ref));
    expect(order).toEqual(['end cast', 'play']);
    expect(mockStartBookInPlace).not.toHaveBeenCalled();
  });

  it("finding 9: another person's book from an old snapshot never ends their cast", async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    useProfiles.setState({
      hydrated: true,
      profiles: [
        { id: 'sam', name: 'Sam', connectionIds: ['c2'] },
        { id: 'alex', name: 'Alex', connectionIds: ['c1'] },
      ],
      activeProfileId: 'sam',
    });
    mockStartBookInPlace.mockResolvedValueOnce(false);
    await handleCarPlayRequest(carItemId(ref));
    expect(mockEndCastForCar).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // FE-13: after a media button start timed out, the start JS was still making (a frozen
  // server) went on to play in the background with no notification and no controls.
  it("a request native gave up on is no longer wanted, another item's cancel leaves it, a new request revives it", async () => {
    stop = startCarSync();
    mockNative.playRequest?.(carItemId(ref));
    await settle();
    const how = mockStartBookInPlace.mock.calls[0][2] as { wanted: () => boolean };
    mockNative.playCancel?.(carItemId({ ...ref, path: 'Other' }));
    expect(how.wanted()).toBe(true);
    mockNative.playCancel?.(carItemId(ref));
    expect(how.wanted()).toBe(false);
    // Asked again (a second press): a start it joins plays.
    mockNative.playRequest?.(carItemId(ref));
    await settle();
    expect(how.wanted()).toBe(true);
  });

  // fe#350: the car taps X (a slow server holds its start), then the loaded book P, which
  // native plays on in X's place: X loads nothing, and the store takes P back.
  describe('a request another play replaced (the last tap wins)', () => {
    const loadedP = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'P',
      trackIndex: 0,
      position: 12,
      rate: 1,
      playing: true,
    };
    /** A start that holds until `finish`: a started one switched the store to its book. */
    let finish: (v: boolean) => void = () => undefined;
    const holdStart = () =>
      mockStartBookInPlace.mockImplementationOnce(
        () =>
          new Promise<boolean>((r) => {
            finish = (v) => {
              if (v) usePlayer.setState({ nowPlaying: { ...ref, queue: { offsets: [0] } } });
              r(v);
            };
          }),
      );

    beforeEach(() => {
      // Native gives up on a car play on Android only (CarPlay keeps no wait of its own).
      Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    });

    it('is superseded, not just unwanted, and the store adopts the book the engine plays', async () => {
      stop = startCarSync();
      await settle();
      holdStart();
      mockNative.playRequest?.(carItemId(ref));
      await settle();
      const how = mockStartBookInPlace.mock.calls[0][2] as {
        wanted: () => boolean;
        superseded: () => boolean;
      };
      expect(how.superseded()).toBe(false);
      mockNative.playCancel?.(carItemId(ref), true);
      expect(how.wanted()).toBe(false);
      expect(how.superseded()).toBe(true);

      mockNative.getLoadedBook.mockResolvedValue(loadedP);
      usePlayer.getState().adoptLoaded.mockClear();
      finish(true);
      await settle();
      expect(usePlayer.getState().adoptLoaded).toHaveBeenCalledWith(loadedP, expect.any(Function));
    });

    // Its wait ran out (it would load paused), then the car tapped the loaded book before it
    // loaded: native says replaced after all, so it loads nothing over the book just asked for.
    it('is superseded when its wait ran out and another play was made before its load', async () => {
      stop = startCarSync();
      await settle();
      holdStart();
      mockNative.playRequest?.(carItemId(ref));
      await settle();
      const how = mockStartBookInPlace.mock.calls[0][2] as {
        wanted: () => boolean;
        superseded: () => boolean;
      };
      mockNative.playCancel?.(carItemId(ref), false);
      expect(how.wanted()).toBe(false);
      expect(how.superseded()).toBe(false);
      mockNative.playCancel?.(carItemId(ref), true);
      expect(how.superseded()).toBe(true);

      mockNative.getLoadedBook.mockResolvedValue(loadedP);
      usePlayer.getState().adoptLoaded.mockClear();
      finish(true);
      await settle();
      expect(usePlayer.getState().adoptLoaded).toHaveBeenCalledWith(loadedP, expect.any(Function));
    });

    // Called off while its place was looked up: the store never named X (`playBook` sets the
    // book after the lookup), yet X's switch let P's saves, save loop and span go. P, the book
    // the store still names and the engine plays, is taken back all the same.
    it('takes the engine book back when the store still names it (called off in its lookup)', async () => {
      usePlayer.setState({
        nowPlaying: { ...loadedP, queue: { offsets: [0] } },
        snapshot: { state: 'playing', trackIndex: 0, position: 12, duration: 100, rate: 1 },
      });
      stop = startCarSync();
      await settle();
      mockStartBookInPlace.mockImplementationOnce(() => new Promise<boolean>((r) => (finish = r)));
      mockNative.playRequest?.(carItemId(ref));
      await settle();
      mockNative.playCancel?.(carItemId(ref), true);
      mockNative.getLoadedBook.mockResolvedValue(loadedP);
      usePlayer.getState().adoptLoaded.mockClear();
      finish(true);
      await settle();
      expect(usePlayer.getState().adoptLoaded).toHaveBeenCalledWith(loadedP, expect.any(Function));
    });

    it('adopts nothing for a timed-out one, nor when the engine holds the book that gave way', async () => {
      stop = startCarSync();
      await settle();
      mockNative.getLoadedBook.mockResolvedValue(loadedP);
      usePlayer.getState().adoptLoaded.mockClear();
      // Its wait ran out (not replaced): it loads paused, and the store keeps it.
      holdStart();
      mockNative.playRequest?.(carItemId(ref));
      await settle();
      mockNative.playCancel?.(carItemId(ref), false);
      finish(true);
      await settle();
      expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();

      // Replaced during its own load: the engine holds it (paused), and it stays.
      mockNative.getLoadedBook.mockResolvedValue({ ...loadedP, path: ref.path });
      holdStart();
      mockNative.playRequest?.(carItemId(ref));
      await settle();
      mockNative.playCancel?.(carItemId(ref), true);
      finish(true);
      await settle();
      expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();

      // A start that never began (called off before its book was read) switched nothing.
      mockNative.getLoadedBook.mockResolvedValue(loadedP);
      holdStart();
      mockNative.playRequest?.(carItemId(ref));
      await settle();
      mockNative.playCancel?.(carItemId(ref), true);
      finish(false);
      await settle();
      expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();
    });
  });

  // An item of a snapshot written before the identity migration names the old connection id:
  // a start of it and of the new id's item are one start (joined by book), so a request under
  // either id takes the other's mark off.
  it('a request under another id of the same book revives the start it joins', async () => {
    setConnectionAliases({ srv: 'c1' });
    try {
      stop = startCarSync();
      const legacy = carItemId({ ...ref, connectionId: 'srv' });
      mockNative.playRequest?.(legacy);
      await settle();
      const how = mockStartBookInPlace.mock.calls[0][2] as { wanted: () => boolean };
      mockNative.playCancel?.(legacy, true);
      expect(how.wanted()).toBe(false);
      mockNative.playRequest?.(carItemId(ref));
      await settle();
      expect(how.wanted()).toBe(true);
      // And a cancel under the new id reaches the start made under the old one.
      mockNative.playCancel?.(carItemId(ref), false);
      expect(how.wanted()).toBe(false);
    } finally {
      setConnectionAliases({});
    }
  });

  // The sync stopping (the root layout gone while the runtime lives on) forgot the mark, so a
  // start a frozen server still held read as wanted again and played.
  it('a request native gave up on stays unwanted once the sync stops', async () => {
    stop = startCarSync();
    mockNative.playRequest?.(carItemId(ref));
    await settle();
    const how = mockStartBookInPlace.mock.calls[0][2] as { wanted: () => boolean };
    mockNative.playCancel?.(carItemId(ref));
    stop();
    stop = () => {};
    expect(how.wanted()).toBe(false);
  });

  it('a request called off while JS booted starts nothing, the loaded book included', async () => {
    let release = () => {};
    const hold = () => {
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest.mocked(bootstrapPlayback).mockImplementation(() => held);
    };
    stop = startCarSync();
    await settle();
    try {
      mockEndCastForCar.mockClear();
      hold();
      mockNative.playRequest?.(carItemId(ref));
      await settle();
      mockNative.playCancel?.(carItemId(ref));
      release();
      await settle();
      expect(mockStartBookInPlace).not.toHaveBeenCalled();
      // Nor is a cast ended for it.
      expect(mockEndCastForCar).not.toHaveBeenCalled();

      usePlayer.setState({
        nowPlaying: { ...ref, queue: { offsets: [0], total: 100 } },
        snapshot: { state: 'paused', trackIndex: 0, position: 40, duration: 100, rate: 1 },
      });
      hold();
      mockNative.playRequest?.(carItemId(ref));
      await settle();
      mockNative.playCancel?.(carItemId(ref));
      release();
      await settle();
      expect(usePlayer.getState().toggle).not.toHaveBeenCalled();
    } finally {
      jest.mocked(bootstrapPlayback).mockImplementation(async () => {});
    }
  });

  it('ignores an id that is not a car item, and logs a failed start', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await handleCarPlayRequest('nonsense');
    expect(mockStartBookInPlace).not.toHaveBeenCalled();
    mockStartBookInPlace.mockRejectedValueOnce(new Error('offline'));
    await expect(handleCarPlayRequest(carItemId(ref))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('bookmarks from outside the app', () => {
  /** The book loaded here: two files of 100 s (the second starts at 100). */
  const load = (path = 'A/Book.m4b') =>
    usePlayer.setState({
      nowPlaying: {
        connectionId: 'c1',
        libraryId: 2,
        path,
        queue: { offsets: [0, 100], tracks: [{ id: '2:A/1.mp3' }, { id: '2:A/2.mp3' }] },
      },
    });

  it("adds one at the loaded book's whole-book place at the press, without a label", async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle();
    load();
    mockNative.bookmark?.(1, 23.6);
    await settle();
    expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'A/Book.m4b', 124);
  });

  it('drops a press with no book loaded', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle();
    mockNative.bookmark?.(0, 5);
    await settle();
    expect(mockAddBookmark).not.toHaveBeenCalled();
    expect((await getItem<unknown[]>('audiosilo.carBookmarks')) ?? []).toHaveLength(0);
  });

  it('keeps one that cannot reach its server and adds it at the next drain', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle();
    load();
    mockAddBookmark.mockRejectedValueOnce(new TypeError('Network request failed'));
    mockNative.bookmark?.(0, 50);
    await settle();
    // Kept in its file, with its whole-book place (fe#146).
    expect(await getItem('audiosilo.carBookmarks')).toEqual([
      {
        connectionId: 'c1',
        libraryId: 2,
        path: 'A/Book.m4b',
        trackId: '2:A/1.mp3',
        positionInTrack: 50,
        position: 50,
      },
    ]);

    mockAddBookmark.mockClear();
    usePlayer.setState({ nowPlaying: null });
    // Back in the foreground: the drain adds it, at the place kept (a book neither loaded nor
    // downloaded: its server is never asked for the book before the send).
    appStateListener?.('background');
    appStateListener?.('active');
    await settle();
    expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'A/Book.m4b', 50);
    const asked = [...mockClients.c1.item.mock.calls, ...mockClients.c1.chapters.mock.calls];
    expect(asked.filter((c) => c[1] === 'A/Book.m4b')).toEqual([]);
    expect(await getItem('audiosilo.carBookmarks')).toEqual([]);
  });

  describe('a kept one across a re-ordered download (fe#146)', () => {
    // Files of 100 s (D/1) and 60 s (D/2), so a whole-book place reads as another file's
    // in the other order.
    const withLengths = (order: [number, number]) => {
      const e = downloaded('c1', 'D');
      e.manifest.chapters = {
        ...twoFileChapters,
        files: twoFileChapters.files.map((f, i) => ({
          ...f,
          seq: order[i],
          duration: i === 0 ? 100 : 60,
        })),
      };
      return e;
    };
    const redrain = async () => {
      mockAddBookmark.mockClear();
      appStateListener?.('background');
      appStateListener?.('active');
      await settle();
    };

    it('keeps it in its file and lands it in that file once the download takes the other order', async () => {
      connect(['c1']);
      mockClients.c1 = fakeClient({});
      useDownloads.setState({ entries: { 'c1:2:D': withLengths([0, 1]) } });
      // Pressed with no JS running: file 2 (D/2.mp3), 30 s in = whole-book 130.
      mockNative.consumePendingBookmarks.mockResolvedValueOnce([
        { connectionId: 'c1', libraryId: 2, path: 'D', trackIndex: 1, position: 30 },
      ]);
      mockAddBookmark.mockRejectedValueOnce(new TypeError('Network request failed'));
      stop = startCarSync();
      await settle();
      expect(await getItem('audiosilo.carBookmarks')).toEqual([
        {
          connectionId: 'c1',
          libraryId: 2,
          path: 'D',
          trackId: '2:D/2.mp3',
          positionInTrack: 30,
          position: 130,
        },
      ]);

      // The download takes the server's other order: D/2 (60 s) first, then D/1. The kept
      // whole-book 130 would read as D/1 70 s in there; its file place is D/2 at 30.
      useDownloads.setState({ entries: { 'c1:2:D': withLengths([1, 0]) } });
      await redrain();
      expect(mockAddBookmark).toHaveBeenCalledTimes(1);
      expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'D', 30);
      expect(await getItem('audiosilo.carBookmarks')).toEqual([]);
    });

    it('keeps the place read on each try, in its file, until it is added', async () => {
      connect(['c1']);
      mockClients.c1 = fakeClient({});
      useDownloads.setState({ entries: { 'c1:2:D': withLengths([1, 0]) } });
      await setItem('audiosilo.carBookmarks', [
        {
          connectionId: 'c1',
          libraryId: 2,
          path: 'D',
          trackId: '2:D/2.mp3',
          positionInTrack: 30,
          position: 130,
        },
      ]);
      mockAddBookmark.mockRejectedValueOnce(new TypeError('Network request failed'));
      stop = startCarSync();
      await settle();
      // Read again in the order now: the same file, its whole-book place on this timeline.
      expect(await getItem('audiosilo.carBookmarks')).toEqual([
        {
          connectionId: 'c1',
          libraryId: 2,
          path: 'D',
          trackId: '2:D/2.mp3',
          positionInTrack: 30,
          position: 30,
        },
      ]);
    });

    it('still reads one kept at only a whole-book place (kept before fe#146)', async () => {
      connect(['c1']);
      mockClients.c1 = fakeClient({});
      useDownloads.setState({ entries: { 'c1:2:D': withLengths([1, 0]) } });
      await setItem('audiosilo.carBookmarks', [
        { connectionId: 'c1', libraryId: 2, path: 'D', position: 130 },
      ]);
      stop = startCarSync();
      await settle();
      expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'D', 130);
      expect(await getItem('audiosilo.carBookmarks')).toEqual([]);
    });

    it('falls back to its whole-book place for a file the download no longer holds', async () => {
      connect(['c1']);
      mockClients.c1 = fakeClient({});
      useDownloads.setState({ entries: { 'c1:2:D': withLengths([0, 1]) } });
      await setItem('audiosilo.carBookmarks', [
        {
          connectionId: 'c1',
          libraryId: 2,
          path: 'D',
          trackId: '2:D/gone.mp3',
          positionInTrack: 5,
          position: 42,
        },
      ]);
      stop = startCarSync();
      await settle();
      expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'D', 42);
    });

    it('lands a press made with no JS in the file it names, read in the order the download took since (fe#185)', async () => {
      connect(['c1']);
      mockClients.c1 = fakeClient({});
      // The download took the server's other order: D/2 (60 s) first, then D/1 (100 s). The
      // press was made in the engine's old order, where D/2 was index 1: by its index it
      // would read as D/1 (60 + 30 = 90).
      useDownloads.setState({ entries: { 'c1:2:D': withLengths([1, 0]) } });
      mockNative.consumePendingBookmarks.mockResolvedValueOnce([
        {
          connectionId: 'c1',
          libraryId: 2,
          path: 'D',
          trackIndex: 1,
          position: 30,
          relPath: 'D/2.mp3',
        },
      ]);
      stop = startCarSync();
      await settle();
      expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'D', 30);
    });

    it('still reads a press an older binary kept (no file path) by its index', async () => {
      connect(['c1']);
      mockClients.c1 = fakeClient({});
      useDownloads.setState({ entries: { 'c1:2:D': withLengths([1, 0]) } });
      mockNative.consumePendingBookmarks.mockResolvedValueOnce([
        { connectionId: 'c1', libraryId: 2, path: 'D', trackIndex: 1, position: 30 },
      ]);
      stop = startCarSync();
      await settle();
      expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'D', 90);
    });

    it('keeps a press naming its file while its place cannot be read, and reads it by that file later', async () => {
      connect(['c1']);
      mockClients.c1 = fakeClient({});
      // Not downloaded, not loaded, the server out of reach: kept in engine coordinates.
      mockNative.consumePendingBookmarks.mockResolvedValueOnce([
        {
          connectionId: 'c1',
          libraryId: 2,
          path: 'D',
          trackIndex: 1,
          position: 30,
          relPath: 'D/2.mp3',
        },
      ]);
      stop = startCarSync();
      await settle();
      expect(mockAddBookmark).not.toHaveBeenCalled();
      expect(await getItem('audiosilo.carBookmarks')).toEqual([
        {
          connectionId: 'c1',
          libraryId: 2,
          path: 'D',
          trackIndex: 1,
          positionInTrack: 30,
          trackId: '2:D/2.mp3',
        },
      ]);
      // Downloaded since, in the other order: the kept one lands in D/2.
      useDownloads.setState({ entries: { 'c1:2:D': withLengths([1, 0]) } });
      await redrain();
      expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'D', 30);
      expect(await getItem('audiosilo.carBookmarks')).toEqual([]);
    });

    it('lands a live press on the engine’s book in the file it names', async () => {
      connect(['c1']);
      mockClients.c1 = fakeClient({});
      useDownloads.setState({ entries: { 'c1:2:D': withLengths([1, 0]) } });
      stop = startCarSync();
      await settle();
      mockNative.bookmark?.(1, 30, { connectionId: 'c1', libraryId: 2, path: 'D' }, 'D/2.mp3');
      await settle();
      expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'D', 30);
    });

    it('ignores a kept one in the new form with a malformed place', async () => {
      connect(['c1']);
      mockClients.c1 = fakeClient({});
      await setItem('audiosilo.carBookmarks', [
        { connectionId: 'c1', libraryId: 2, path: 'D', trackId: '2:D/2.mp3', position: 5 },
      ]);
      stop = startCarSync();
      await settle();
      expect(mockAddBookmark).not.toHaveBeenCalled();
    });
  });

  it('keeps one in file coordinates while its place cannot be read yet', async () => {
    // Not downloaded and not loaded, its server out of reach: no timeline to read.
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    mockNative.consumePendingBookmarks.mockResolvedValueOnce([
      { connectionId: 'c1', libraryId: 2, path: 'S', trackIndex: 1, position: 10 },
    ]);
    stop = startCarSync();
    await settle();
    expect(mockAddBookmark).not.toHaveBeenCalled();
    expect(await getItem('audiosilo.carBookmarks')).toEqual([
      { connectionId: 'c1', libraryId: 2, path: 'S', trackIndex: 1, positionInTrack: 10 },
    ]);
  });

  it('drops one the server refuses', async () => {
    const { ApiError } = jest.requireActual('@/api/client');
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle();
    load();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockAddBookmark.mockRejectedValueOnce(new ApiError(404, 'gone'));
    mockNative.bookmark?.(0, 50);
    await settle();
    expect((await getItem<unknown[]>('audiosilo.carBookmarks')) ?? []).toHaveLength(0);
    warn.mockRestore();
  });

  it('adds those pressed while no JS ran at start, each at its own place, skipping a gone connection', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
    mockNative.consumePendingBookmarks.mockResolvedValueOnce([
      {
        connectionId: 'c1',
        libraryId: 2,
        path: 'D',
        trackIndex: 1,
        position: 30,
      },
      {
        connectionId: 'gone',
        libraryId: 2,
        path: 'D',
        trackIndex: 0,
        position: 5,
      },
    ]);
    stop = startCarSync();
    await settle();
    // File 2 of the downloaded book starts at 100 on its timeline.
    expect(mockAddBookmark).toHaveBeenCalledTimes(1);
    expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'D', 130);
  });

  it('keeps those whose session has not loaded yet (no connection reads as gone), adding them once it has', async () => {
    // A session that failed to load (a CarPlay launch with the phone locked): every
    // connection reads as gone, and dropping the bookmarks would lose them.
    mockSessionReady = false;
    try {
      useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
      mockNative.consumePendingBookmarks.mockResolvedValueOnce([
        { connectionId: 'c1', libraryId: 2, path: 'D', trackIndex: 1, position: 30 },
      ]);
      stop = startCarSync();
      await settle();
      expect(mockAddBookmark).not.toHaveBeenCalled();
      expect(await getItem<unknown[]>('audiosilo.carBookmarks')).toHaveLength(1);
    } finally {
      mockSessionReady = true;
    }
    // It loads; back in the foreground the drain adds the kept one at its place.
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    appStateListener?.('background');
    appStateListener?.('active');
    await settle();
    expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'D', 130);
    expect(await getItem('audiosilo.carBookmarks')).toEqual([]);
  });

  it('adds ones naming an old connection id (from before the identity migration) on its new one', async () => {
    setConnectionAliases({ srv: 'srv.3' });
    try {
      connect(['srv.3']);
      mockClients['srv.3'] = fakeClient({});
      useDownloads.setState({ entries: { 'srv.3:2:D': downloaded('srv.3', 'D') } });
      // One kept from an earlier drain (read back here, so resolved here); one the Android
      // service queued while no JS ran, which the native adapter already resolved
      // (`car-native.native.test.ts`).
      await setItem('audiosilo.carBookmarks', [
        { connectionId: 'srv', libraryId: 2, path: 'D', position: 12 },
      ]);
      mockNative.consumePendingBookmarks.mockResolvedValueOnce([
        { connectionId: 'srv.3', libraryId: 2, path: 'D', trackIndex: 1, position: 30 },
      ]);
      stop = startCarSync();
      await settle();
      expect(mockAddBookmark.mock.calls).toEqual([
        ['srv.3', 2, 'D', 12],
        ['srv.3', 2, 'D', 130],
      ]);
      expect(await getItem('audiosilo.carBookmarks')).toEqual([]);
    } finally {
      setConnectionAliases({});
    }
  });

  it('reads a streaming book’s timeline through its item and chapters', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({
      items: { S: makeBook({ rel_path: 'S', duration: 200, is_folder: true }) },
      chapters: { S: { ...twoFileChapters, path: 'S' } },
    });
    mockNative.consumePendingBookmarks.mockResolvedValueOnce([
      { connectionId: 'c1', libraryId: 2, path: 'S', trackIndex: 1, position: 10 },
    ]);
    stop = startCarSync();
    await settle();
    expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'S', 110);
  });
});

describe('adopting the service’s book (Android)', () => {
  const loaded = {
    connectionId: 'c1',
    libraryId: 2,
    path: 'D',
    trackIndex: 1,
    position: 30,
    rate: 1,
    playing: true,
  };

  it('adopts it at start when the player has none', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    mockNative.getLoadedBook.mockResolvedValue(loaded);
    stop = startCarSync();
    await settle();
    expect(usePlayer.getState().adoptLoaded).toHaveBeenCalledWith(loaded, expect.any(Function));
  });

  it('finding 9: stops unauthorized native audio without adopting or saving it', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    mockNative.getLoadedBook.mockResolvedValue(loaded);
    useProfiles.setState({
      hydrated: true,
      profiles: [
        { id: 'sam', name: 'Sam', connectionIds: ['c2'] },
        { id: 'alex', name: 'Alex', connectionIds: ['c1'], hasPin: true },
      ],
      activeProfileId: 'sam',
    });
    stop = startCarSync();
    await settle();
    expect(mockNative.stopPlayback).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();
  });

  it("finding 9: stops another person's book named by its legacy connection id", async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    mockNative.stopPlayback.mockClear();
    // A play spec from a snapshot written before the identity migration.
    mockNative.getLoadedBook.mockResolvedValue({ ...loaded, connectionId: 'srv' });
    setConnectionAliases({ srv: 'c1' });
    useProfiles.setState({
      hydrated: true,
      profiles: [
        { id: 'sam', name: 'Sam', connectionIds: ['c2'] },
        { id: 'alex', name: 'Alex', connectionIds: ['c1'], hasPin: true },
      ],
      activeProfileId: 'sam',
    });
    try {
      stop = startCarSync();
      await settle();
      expect(mockNative.stopPlayback).toHaveBeenCalledTimes(1);
      expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();
    } finally {
      setConnectionAliases({});
    }
  });

  it('leaves the player alone when it already has that book, or one is loading', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    mockNative.getLoadedBook.mockResolvedValue(loaded);
    usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'D', queue: { offsets: [0, 100] } },
    });
    stop = startCarSync();
    await settle();
    expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();

    usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'Other', queue: { offsets: [0] } },
      loadingBook: 'c1:2:Other',
      snapshot: { state: 'loading', trackIndex: 0, position: 0, duration: 0, rate: 1 },
    });
    await settle();
    expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();
  });

  it('adopts a book the car switched to while another was loaded', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'A', queue: { offsets: [0] } },
      snapshot: { state: 'paused', trackIndex: 0, position: 10, duration: 100, rate: 1 },
    });
    stop = startCarSync();
    await settle();
    expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();
    mockNative.getLoadedBook.mockResolvedValue(loaded);
    usePlayer.setState({
      snapshot: { state: 'playing', trackIndex: 1, position: 30, duration: 100, rate: 1 },
    });
    await settle();
    expect(usePlayer.getState().adoptLoaded).toHaveBeenCalledWith(loaded, expect.any(Function));
  });

  // The engine's reports name their book: the store holds another book's, so its own state
  // never changes for one, and tells the car sync instead.
  it("adopts the book the engine holds when the store says it reported another book's", async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'A', queue: { offsets: [0] } },
      snapshot: { state: 'paused', trackIndex: 0, position: 10, duration: 100, rate: 1 },
    });
    stop = startCarSync();
    await settle();
    expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();
    mockNative.getLoadedBook.mockResolvedValue(loaded);
    mockOtherBookReported?.('moved');
    await settle();
    expect(usePlayer.getState().adoptLoaded).toHaveBeenCalledWith(loaded, expect.any(Function));
    // Not on iOS, whose engine only ever holds what the store loaded.
    stop();
    (usePlayer.getState().adoptLoaded as jest.Mock).mockClear();
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    stop = startCarSync();
    await settle();
    mockOtherBookReported?.('moved');
    await settle();
    expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();
  });

  // The review: after "Playback stopped", a car, headset or resumption play of another book
  // was followed as a press of the store's book, and its watchdog paused that other book once
  // it took longer than the grace to start. It is adopted as the play it is.
  it('adopts a book the engine was asked to play from outside after playback stopped', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'A', queue: { offsets: [0] } },
      snapshot: { state: 'error', trackIndex: 0, position: 10, duration: 100, rate: 1 },
    });
    stop = startCarSync();
    await settle();
    expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();
    mockNative.getLoadedBook.mockResolvedValue({ ...loaded, playing: true });
    // The store follows the outside play as a press: `loading`, before the engine plays.
    usePlayer.setState({
      snapshot: { state: 'loading', trackIndex: 0, position: 10, duration: 100, rate: 1 },
    });
    await settle();
    expect(usePlayer.getState().adoptLoaded).toHaveBeenCalledWith(loaded, expect.any(Function));
  });

  // The review: the store's own Retry (or play) after playback stopped makes the same `error`
  // to `loading` turn, and cost a read of the engine's book that could only name its own.
  it("asks nothing of the engine on the store's own Retry after playback stopped", async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'A', queue: { offsets: [0] } },
      snapshot: { state: 'error', trackIndex: 0, position: 10, duration: 100, rate: 1 },
    });
    stop = startCarSync();
    await settle();
    mockNative.getLoadedBook.mockClear();
    mockOutsidePlay = false;
    try {
      usePlayer.setState({
        snapshot: { state: 'loading', trackIndex: 0, position: 10, duration: 100, rate: 1 },
      });
      await settle();
      expect(mockNative.getLoadedBook).not.toHaveBeenCalled();
      expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();
    } finally {
      mockOutsidePlay = true;
    }
  });

  // The store holds the engine's reports while an outside play's book is adopted, so no
  // change of its own says the engine went on to yet another book meanwhile: an adoption that
  // gave up reads the engine once more, and the book it holds by then is adopted.
  it('reads the engine again when an adoption gave up on a book the engine no longer holds', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'A', queue: { offsets: [0] } },
      snapshot: { state: 'error', trackIndex: 0, position: 10, duration: 100, rate: 1 },
    });
    stop = startCarSync();
    await settle();
    const adoptLoaded = jest.mocked(usePlayer.getState().adoptLoaded);
    const other = { ...loaded, path: 'E' };
    // The engine holds E by the time D's adoption has read its book and given up.
    adoptLoaded.mockImplementationOnce(async () => {
      mockNative.getLoadedBook.mockResolvedValue(other);
      return false;
    });
    mockNative.getLoadedBook.mockResolvedValue({ ...loaded, playing: true });
    usePlayer.setState({
      snapshot: { state: 'loading', trackIndex: 0, position: 10, duration: 100, rate: 1 },
    });
    await settle();
    expect(adoptLoaded).toHaveBeenCalledTimes(2);
    expect(adoptLoaded).toHaveBeenLastCalledWith(other, expect.any(Function));
  });

  // An adoption that gave up on the book the engine still holds is not asked for again.
  it('asks once for a book whose adoption gave up while the engine still holds it', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'A', queue: { offsets: [0] } },
      snapshot: { state: 'error', trackIndex: 0, position: 10, duration: 100, rate: 1 },
    });
    stop = startCarSync();
    await settle();
    const adoptLoaded = jest.mocked(usePlayer.getState().adoptLoaded);
    adoptLoaded.mockResolvedValueOnce(false);
    mockNative.getLoadedBook.mockResolvedValue({ ...loaded, playing: true });
    usePlayer.setState({
      snapshot: { state: 'loading', trackIndex: 0, position: 10, duration: 100, rate: 1 },
    });
    await settle();
    expect(adoptLoaded).toHaveBeenCalledTimes(1);
  });

  // The review: a change of the engine's seen while a check was running joined that check,
  // which had read the engine before it (its adoption then gave up on the book the engine no
  // longer held), and nothing asked about the book the engine held by then.
  it('reads the engine again when it changed while a check was running', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'A', queue: { offsets: [0] } },
      snapshot: { state: 'error', trackIndex: 0, position: 10, duration: 100, rate: 1 },
    });
    stop = startCarSync();
    await settle();
    const adoptLoaded = jest.mocked(usePlayer.getState().adoptLoaded);
    let giveUp: (adopted: boolean) => void = () => {};
    adoptLoaded.mockImplementationOnce(() => new Promise<boolean>((resolve) => (giveUp = resolve)));
    mockNative.getLoadedBook.mockResolvedValue({ ...loaded, playing: true });
    usePlayer.setState({
      snapshot: { state: 'loading', trackIndex: 0, position: 10, duration: 100, rate: 1 },
    });
    await settle();
    expect(adoptLoaded).toHaveBeenCalledTimes(1);
    // The service starts yet another book while that one is read.
    const other = { ...loaded, path: 'E' };
    mockNative.getLoadedBook.mockResolvedValue(other);
    usePlayer.setState({
      snapshot: { state: 'loading', trackIndex: 1, position: 0, duration: 100, rate: 1 },
    });
    await settle();
    expect(adoptLoaded).toHaveBeenCalledTimes(1);
    giveUp(false);
    await settle();
    expect(adoptLoaded).toHaveBeenCalledTimes(2);
    expect(adoptLoaded).toHaveBeenLastCalledWith(other, expect.any(Function));
  });

  it('never brings back a book the store finished or stopped while the service was asked', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const playing = {
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'D', queue: { offsets: [0, 100] } },
      snapshot: { state: 'playing', trackIndex: 0, position: 99, duration: 100, rate: 1 },
    };
    usePlayer.setState(playing);
    stop = startCarSync();
    await settle();
    let answer: (v: unknown) => void = () => {};
    mockNative.getLoadedBook.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    // The engine moves on a file (a check is asked), then the book finishes: the store drops
    // it before the answer.
    usePlayer.setState({ snapshot: { ...playing.snapshot, trackIndex: 1, position: 0 } });
    expect(mockNative.getLoadedBook).toHaveBeenCalled();
    usePlayer.setState({
      nowPlaying: null,
      snapshot: { state: 'idle', trackIndex: 0, position: 0, duration: 0, rate: 1 },
    });
    answer({ ...loaded, path: 'Other' });
    await settle();
    expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();
  });

  it("asks nothing for the store's own changes: a book switch, its load, a pause, a stop", async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    stop = startCarSync();
    await settle();
    mockNative.getLoadedBook.mockClear();
    const book = (path: string) => ({
      connectionId: 'c1',
      libraryId: 2,
      path,
      queue: { offsets: [0, 100] },
    });
    const at = (state: string, trackIndex = 0) => ({
      state,
      trackIndex,
      position: 0,
      duration: 100,
      rate: 1,
    });
    const a = book('A');
    // playBook: the switch with the load pending, the load landing on another file, then
    // the clear; then a pause and a stop.
    usePlayer.setState({ nowPlaying: a, loadingBook: 'c1:2:A', snapshot: at('loading') });
    usePlayer.setState({ snapshot: at('ready', 1) });
    usePlayer.setState({ loadingBook: null, snapshot: at('loading', 1) });
    usePlayer.setState({ snapshot: at('paused', 1) });
    usePlayer.setState({ nowPlaying: null, snapshot: at('idle') });
    await settle();
    expect(mockNative.getLoadedBook).not.toHaveBeenCalled();
  });

  it('never asks on iOS (the service has no book of its own there)', async () => {
    mockNative.getLoadedBook.mockResolvedValue(loaded);
    stop = startCarSync();
    await settle();
    expect(mockNative.getLoadedBook).not.toHaveBeenCalled();
  });
});

describe('before the launch steps finish', () => {
  const mockBootstrap = jest.requireMock('@/lib/bootstrap').bootstrapPlayback as jest.Mock;
  afterEach(() => {
    mockBootstrap.mockImplementation(async () => {});
  });

  it('acts on a car request or connect replayed at subscribe only once the stores are hydrated', async () => {
    // One run, as the real memoised `bootstrapPlayback`: every caller waits on it.
    let release!: () => void;
    const launch = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockBootstrap.mockImplementation(() => launch);
    // Not hydrated yet: no connection (the root layout starts the sync with the launch steps).
    connect([]);
    stop = startCarSync();
    const ref = { connectionId: 'c1', libraryId: 2, path: 'B' };
    mockNative.connection?.(true);
    mockNative.playRequest?.(carItemId(ref));
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(mockStartBookInPlace).not.toHaveBeenCalled();
    expect(mockNative.setSnapshot).not.toHaveBeenCalled();

    connect(['c1']);
    mockClients.c1 = fakeClient({});
    release();
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(mockStartBookInPlace).toHaveBeenCalledWith(ref, {}, carStart);
    // Never a signed-out snapshot over the good one.
    expect(mockNative.setSnapshot).toHaveBeenCalled();
    for (const [json] of mockNative.setSnapshot.mock.calls) {
      expect(JSON.parse(json as string).signedIn).toBe(true);
    }
  });
});

describe("the engine's book", () => {
  it('adds a bookmark to the book the engine names, even before the store holds it', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
    stop = startCarSync();
    await settle();
    // The store holds another book (or none yet): the press is D's, file 2 at 30 s.
    usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'A', queue: { offsets: [0, 500] } },
    });
    mockNative.bookmark?.(1, 30, { connectionId: 'c1', libraryId: 2, path: 'D' });
    await settle();
    expect(mockAddBookmark).toHaveBeenCalledTimes(1);
    expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'D', 130);
  });

  it("lists the Up next queue of the loaded book's server, as the app's Up next does", async () => {
    connect(['c1', 'c2']);
    mockCaps.c1 = { queue: true };
    mockCaps.c2 = { queue: true };
    const entry = (path: string) => ({
      library_id: 2,
      path,
      added_at: 'x',
      book: makeBook({ rel_path: path, title: path }),
    });
    mockClients.c1 = fakeClient({ queue: [entry('Q1')] });
    mockClients.c2 = fakeClient({ queue: [entry('Q2')] });
    usePlayer.setState({
      nowPlaying: {
        connectionId: 'c2',
        libraryId: 2,
        path: 'X',
        queue: { offsets: [0], total: 10 },
      },
    });
    stop = startCarSync();
    await settle();
    expect(tab(lastSnapshot(), 'upnext')!.items.map((i) => i.title)).toEqual(['Q2']);
  });

  it('still asks native after a check that ran while a book was loading (Android)', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    // A book is loading when the sync starts: that check stands back at once.
    usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'A', queue: { offsets: [0] } },
      loadingBook: 'c1:2:A',
      snapshot: { state: 'loading', trackIndex: 0, position: 0, duration: 100, rate: 1 },
    });
    stop = startCarSync();
    await settle();
    usePlayer.setState({
      loadingBook: null,
      snapshot: { state: 'paused', trackIndex: 0, position: 10, duration: 100, rate: 1 },
    });
    await settle();
    // Later the service plays another book on its own: the store adopts it.
    const loaded = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'D',
      trackIndex: 1,
      position: 30,
      rate: 1,
      playing: true,
    };
    mockNative.getLoadedBook.mockResolvedValue(loaded);
    usePlayer.setState({
      snapshot: { state: 'playing', trackIndex: 1, position: 30, duration: 100, rate: 1 },
    });
    await settle();
    expect(usePlayer.getState().adoptLoaded).toHaveBeenCalledWith(loaded, expect.any(Function));
  });
});

describe('offline', () => {
  function unreachable(client: FakeClient) {
    const offline = new TypeError('Network request failed');
    client.allProgress.mockRejectedValue(offline);
    client.queue.mockRejectedValue(offline);
    client.libraries.mockRejectedValue(offline);
    client.listBooks.mockRejectedValue(offline);
  }

  it('keeps the snapshot native has when no server can be read, and its covers', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({
      progress: [makeProgress({ path: 'P1', position: 60 })],
      items: { P1: makeBook({ rel_path: 'P1', title: 'Progressing' }) },
    });
    stop = startCarSync();
    await settle();
    expect(tab(lastSnapshot(), 'continue')!.items.map((i) => i.title)).toEqual(['Progressing']);

    // A fresh runtime in the car, away from the server: nothing read, nothing cached.
    stop();
    forgetCarSync();
    mockNative.setSnapshot.mockClear();
    (pruneArtwork as jest.Mock).mockClear();
    unreachable(mockClients.c1);
    stop = startCarSync();
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(mockNative.setSnapshot).not.toHaveBeenCalled();
    expect(pruneArtwork).not.toHaveBeenCalled();
  });

  it('finding 9: an offline profile switch replaces the previous native snapshot', async () => {
    connect(['c1', 'c2']);
    mockClients.c1 = fakeClient({});
    mockClients.c2 = fakeClient({});
    useProfiles.setState({
      hydrated: true,
      activeProfileId: 'alice',
      profiles: [
        { id: 'alice', name: 'Alice', connectionIds: ['c1'] },
        { id: 'bob', name: 'Bob', connectionIds: ['c2'] },
      ],
    });
    useDownloads.setState({
      entries: { 'c1:2:D': downloaded('c1', 'D'), 'c2:2:E': downloaded('c2', 'E') },
    });
    stop = startCarSync();
    await settle();
    mockNative.setSnapshot.mockClear();
    unreachable(mockClients.c1);
    unreachable(mockClients.c2);
    usePlayer.setState({
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'D', queue: { offsets: [0] } },
    });
    useProfiles.setState({ activeProfileId: 'bob' });
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(mockNative.setSnapshot).toHaveBeenCalled();
    expect(tab(lastSnapshot(), 'continue')?.items ?? []).toEqual([]);
    expect(tab(lastSnapshot(), 'downloads')!.items.map((i) => i.title)).toEqual(['Downloaded E']);
  });

  it('still writes what it has when no snapshot was ever written', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    unreachable(mockClients.c1);
    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
    stop = startCarSync();
    await settle();
    expect(tab(lastSnapshot(), 'downloads')!.items.map((i) => i.title)).toEqual(['Downloaded D']);
  });
});
