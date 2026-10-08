import type { Book, ChaptersResponse, Progress, QueueEntry } from '@/api/types';

import type { CarSnapshot } from './car-model';

// --- Mocks ---------------------------------------------------------------------------------

const mockNative = {
  available: true,
  setSnapshot: jest.fn(async (_json: string) => true),
  getLoadedBook: jest.fn(async (): Promise<unknown> => null),
  consumePendingBookmarks: jest.fn(async (): Promise<unknown[]> => []),
  connection: null as ((connected: boolean) => void) | null,
  playRequest: null as ((id: string) => void) | null,
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
};
jest.mock('./car-native', () => ({
  get carNative() {
    return mockNative;
  },
}));

jest.mock('./car-artwork', () => ({
  artworkName: (key: string, version?: string) => `${key}#${version ?? ''}.jpg`,
  existingArtwork: (name: string) => mockArtOnDisk.get(name) ?? null,
  ensureArtwork: jest.fn(async (name: string) => {
    const uri = `file:///docs/car-artwork/${encodeURIComponent(name)}`;
    mockArtOnDisk.set(name, uri);
    return uri;
  }),
  pruneArtwork: jest.fn(),
}));
const mockArtOnDisk = new Map<string, string>();

jest.mock('@/lib/bootstrap', () => ({ bootstrapPlayback: jest.fn(async () => {}) }));

const mockStartBookInPlace = jest.fn(async (..._a: unknown[]) => true);
jest.mock('@/components/player/start-book', () => ({
  startBookInPlace: (...a: unknown[]) => mockStartBookInPlace(...a),
}));

const mockLoadInitialProgress = jest.fn(
  async (
    api: { getProgress: () => Promise<Progress | null> } | null,
    ..._where: [string, number, string]
  ) => {
    const row = api ? await api.getProgress() : null;
    return row ? { kind: 'progress', progress: row } : { kind: api ? 'empty' : 'failed' };
  },
);
jest.mock('@/playback/progress-sync', () => ({
  loadInitialProgress: (...a: Parameters<typeof mockLoadInitialProgress>) =>
    mockLoadInitialProgress(...a),
}));

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
  let remote: ((r: unknown) => void) | null = null;
  return {
    usePlayer,
    onRemoteBookmarkRequest: (l: (r: unknown) => void) => {
      remote = l;
      return () => {
        remote = null;
      };
    },
    mockRemoteBookmark: (r: unknown) => remote?.(r),
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
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (cid: string) => mockClients[cid] ?? null,
  sessionReady: () => true,
}));

/* eslint-disable import/first */
import { AppState, Platform } from 'react-native';

import { useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';
import * as store from '@/playback/store';
import { useLibrarySelection } from '@/stores/library-selection';
import { useSession, type Connection } from '@/stores/session';
import { getItem, setItem } from '@/lib/storage';

import { ensureArtwork } from './car-artwork';
import {
  forgetCarSync,
  handleCarPlayRequest,
  MIN_GAP_MS,
  SETTLE_MS,
  startCarSync,
} from './car-controller';
import { carItemId } from './car-model';
/* eslint-enable import/first */

const usePlayer = store.usePlayer as unknown as {
  getState: () => {
    toggle: jest.Mock;
    adoptLoaded: jest.Mock;
  };
  setState: (s: object) => void;
};
const remoteBookmark = (store as unknown as { mockRemoteBookmark: (r: unknown) => void })
  .mockRemoteBookmark;

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
}) {
  return {
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

beforeEach(() => {
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
  useLibrarySelection.setState({ selection: null });
  connect([]);
});

afterEach(async () => {
  stop();
  stop = () => {};
  await setItem('audiosilo.carBookmarks', []);
  await setItem('audiosilo.carSeen', false);
  jest.clearAllTimers();
  jest.useRealTimers();
});

// --- Tests ---------------------------------------------------------------------------------

describe('startCarSync', () => {
  it('does nothing on the web', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    stop = startCarSync();
    await settle(5_000);
    expect(mockNative.onConnection).not.toHaveBeenCalled();
    expect(mockNative.setSnapshot).not.toHaveBeenCalled();
  });

  it('does nothing on a binary without the car functions', async () => {
    mockNative.available = false;
    stop = startCarSync();
    await settle(5_000);
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
      downloaded: true,
    });
    // The downloaded book's play spec resumes where the listed server row says (through
    // the resume lookup), from its local files.
    expect(d.play).toMatchObject({ startIndex: 1, positionInTrack: 30 });
    expect(d.play!.tracks.map((t) => t.url)).toEqual(['file:///d/1.mp3', 'file:///d/2.mp3']);
    // Only the downloaded book has a play spec; no snapshot names a token or a URL.
    expect(tab(snap, 'library')!.items[0].play).toBeUndefined();
    expect(JSON.stringify(snap)).not.toMatch(/secret|https?:/);
  });

  it('looks a downloaded book up again only when its row changes or it is the loaded book', async () => {
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
    expect(mockLoadInitialProgress).toHaveBeenCalledTimes(2);

    // E becomes the loaded book: only its lookup runs again (its saves move it).
    mockLoadInitialProgress.mockClear();
    usePlayer.setState({
      nowPlaying: {
        connectionId: 'c1',
        libraryId: 2,
        path: 'E',
        queue: { offsets: [0, 100], total: 200 },
      },
      snapshot: { state: 'playing', trackIndex: 0, position: 5, duration: 100, rate: 1 },
    });
    await settle(MIN_GAP_MS);
    expect(mockLoadInitialProgress.mock.calls.map((c) => c[3])).toEqual(['E']);

    // E stops being the loaded book: looked up once more, with its last save in.
    mockLoadInitialProgress.mockClear();
    usePlayer.setState({ nowPlaying: null });
    await settle(MIN_GAP_MS);
    expect(mockLoadInitialProgress.mock.calls.map((c) => c[3])).toEqual(['E']);
  });

  it('leaves Up next out where the default server keeps no queue', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle();
    expect(lastSnapshot().tabs.map((t) => t.id)).toEqual(['continue', 'downloads', 'library']);
  });

  it('uses a downloaded book’s own cover, and fetches no other until a car has connected', async () => {
    connect(['c1']);
    mockCaps.c1 = { cover_sizes: true };
    mockClients.c1 = fakeClient({ books: [makeBook({ rel_path: 'L1', cover_version: 'v7' })] });
    useDownloads.setState({ entries: { 'c1:2:D': downloaded('c1', 'D') } });
    stop = startCarSync();
    await settle();
    expect(tab(lastSnapshot(), 'downloads')!.items[0].artwork).toBe('file:///d/cover.jpg');
    expect(tab(lastSnapshot(), 'library')!.items[0].artwork).toBeNull();
    await settle(SETTLE_MS + MIN_GAP_MS);
    expect(ensureArtwork).not.toHaveBeenCalled();
  });

  it('fetches the missing covers once a car connects, then names them in the next snapshot', async () => {
    connect(['c1']);
    mockCaps.c1 = { cover_sizes: true };
    mockClients.c1 = fakeClient({ books: [makeBook({ rel_path: 'L1', cover_version: 'v7' })] });
    stop = startCarSync();
    await settle();
    mockNative.connection?.(true);
    await settle(MIN_GAP_MS);
    expect(ensureArtwork).toHaveBeenCalledWith(
      'c1:2:L1#v7.jpg',
      'https://srv/cover?lib=2&path=L1&size=320&token=secret',
    );
    expect(await getItem('audiosilo.carSeen')).toBe(true);
    await settle(SETTLE_MS + MIN_GAP_MS);
    const snap = lastSnapshot();
    expect(tab(snap, 'library')!.items[0].artwork).toMatch(/^file:\/\/\/docs\/car-artwork\//);
    expect(JSON.stringify(snap)).not.toMatch(/secret|https?:/);
  });

  it('asks for the full cover from a server without thumbnails (after a car was seen)', async () => {
    await setItem('audiosilo.carSeen', true);
    connect(['c1']);
    mockClients.c1 = fakeClient({ books: [makeBook({ rel_path: 'L1' })] });
    stop = startCarSync();
    await settle();
    expect(ensureArtwork).toHaveBeenCalledWith(
      'c1:2:L1#.jpg',
      'https://srv/cover?lib=2&path=L1&token=secret',
    );
  });

  it('writes again after a list changes, never closer than the gap, and not when nothing changed', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle();
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

    // A book starts right after: as soon as the gap allows, not before.
    usePlayer.setState({
      nowPlaying: {
        connectionId: 'c1',
        libraryId: 2,
        path: 'D',
        queue: { offsets: [0, 100], total: 200 },
      },
      snapshot: { state: 'playing', trackIndex: 0, position: 5, duration: 100, rate: 1 },
    });
    await settle(MIN_GAP_MS - 500);
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(2);
    await settle(600);
    expect(mockNative.setSnapshot).toHaveBeenCalledTimes(3);
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

describe('play requests', () => {
  const ref = { connectionId: 'c1', libraryId: 2, path: 'Some: book.m4b' };

  it('starts the book from its saved place through startBookInPlace', async () => {
    stop = startCarSync();
    mockNative.playRequest?.(carItemId(ref));
    await settle();
    expect(mockStartBookInPlace).toHaveBeenCalledWith(ref);
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
    expect(mockStartBookInPlace).toHaveBeenCalledWith(ref);
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
  it('adds one at the reported place, without a label', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle();
    remoteBookmark({ connectionId: 'c1', libraryId: 2, path: 'A/Book.m4b', position: 123.6 });
    await settle();
    expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'A/Book.m4b', 124);
  });

  it('keeps one that cannot reach its server and adds it at the next drain', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle();
    mockAddBookmark.mockRejectedValueOnce(new TypeError('Network request failed'));
    remoteBookmark({ connectionId: 'c1', libraryId: 2, path: 'A/Book.m4b', position: 50 });
    await settle();
    expect(await getItem('audiosilo.carBookmarks')).toHaveLength(1);

    mockAddBookmark.mockClear();
    // Back in the foreground: the drain adds it.
    appStateListener?.('active');
    await settle();
    expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'A/Book.m4b', 50);
    expect(await getItem('audiosilo.carBookmarks')).toEqual([]);
  });

  it('drops one the server refuses', async () => {
    const { ApiError } = jest.requireActual('@/api/client');
    connect(['c1']);
    mockClients.c1 = fakeClient({});
    stop = startCarSync();
    await settle();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockAddBookmark.mockRejectedValueOnce(new ApiError(404, 'gone'));
    remoteBookmark({ connectionId: 'c1', libraryId: 2, path: 'A/Book.m4b', position: 50 });
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
        at: '2026-10-08T10:00:00Z',
      },
      {
        connectionId: 'gone',
        libraryId: 2,
        path: 'D',
        trackIndex: 0,
        position: 5,
        at: '2026-10-08T10:01:00Z',
      },
    ]);
    stop = startCarSync();
    await settle();
    // File 2 of the downloaded book starts at 100 on its timeline.
    expect(mockAddBookmark).toHaveBeenCalledTimes(1);
    expect(mockAddBookmark).toHaveBeenCalledWith('c1', 2, 'D', 130);
  });

  it('reads a streaming book’s timeline through its item and chapters', async () => {
    connect(['c1']);
    mockClients.c1 = fakeClient({
      items: { S: makeBook({ rel_path: 'S', duration: 200, is_folder: true }) },
      chapters: { S: { ...twoFileChapters, path: 'S' } },
    });
    mockNative.consumePendingBookmarks.mockResolvedValueOnce([
      { connectionId: 'c1', libraryId: 2, path: 'S', trackIndex: 1, position: 10, at: 'x' },
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
    expect(usePlayer.getState().adoptLoaded).toHaveBeenCalledWith(loaded);
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
    expect(usePlayer.getState().adoptLoaded).toHaveBeenCalledWith(loaded);
  });

  it('never brings back a book the store finished or stopped while the service was asked', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const playing = {
      nowPlaying: { connectionId: 'c1', libraryId: 2, path: 'D', queue: { offsets: [0, 100] } },
      snapshot: { state: 'playing', trackIndex: 1, position: 99, duration: 100, rate: 1 },
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
    // The book ends (a check is asked), then finishes: the store drops it before the answer.
    usePlayer.setState({ snapshot: { ...playing.snapshot, state: 'ended' } });
    usePlayer.setState({
      nowPlaying: null,
      snapshot: { state: 'idle', trackIndex: 0, position: 0, duration: 0, rate: 1 },
    });
    answer({ ...loaded, path: 'Other' });
    await settle();
    expect(usePlayer.getState().adoptLoaded).not.toHaveBeenCalled();
  });

  it('never asks on iOS (the service has no book of its own there)', async () => {
    mockNative.getLoadedBook.mockResolvedValue(loaded);
    stop = startCarSync();
    await settle();
    expect(mockNative.getLoadedBook).not.toHaveBeenCalled();
  });
});
