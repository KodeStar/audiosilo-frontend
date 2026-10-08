import { focusManager, onlineManager, QueryObserver, skipToken } from '@tanstack/react-query';

import { ApiError, TimeoutError, type ApiClient } from '@/api/client';
import type { Capabilities, Progress, ServerInfo } from '@/api/types';

// The fetch helper is deliberately framework-free, so the two collaborators it can reach
// (the reachability layer and the durable progress mirror) are mocked and asserted on.
const mockNoteError = jest.fn();
jest.mock('@/api/reachability', () => ({
  noteError: (...args: unknown[]) => mockNoteError(...args),
}));

const mockMirroredProgress = jest.fn(async (..._args: unknown[]): Promise<Progress | null> => null);
jest.mock('@/playback/progress-sync', () => ({
  mirroredProgress: (...args: unknown[]) => mockMirroredProgress(...args),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

// The provider is React-Query/session-bound; hooks.ts only needs it at hook call time,
// and this suite exercises the pure helpers. Its query client is a real one with the
// app's retry default (a capability read must not wait on a retry), whose invalidations
// are only recorded.
jest.mock('@/api/provider', () => {
  const { QueryClient } = jest.requireActual('@tanstack/react-query');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
  queryClient.invalidateQueries = jest.fn();
  return {
    queryClient,
    useApi: jest.fn(),
    useApis: jest.fn(),
    useCid: jest.fn(),
    useOptionalApi: jest.fn(),
  };
});

const mockResolveClient = jest.fn((_cid: string): unknown => null);
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (cid: string) => mockResolveClient(cid),
}));

/* eslint-disable import/first */
import {
  addBookmark,
  addNote,
  anyCapability,
  bookMetaQuery,
  chaptersQuery,
  fetchBookProgress,
  fetchCapabilities,
  flattenPages,
  historyQuery,
  chaptersKeyParts,
  isQueueKey,
  isSearchKey,
  META_STALE_MS,
  metaWorkQuery,
  qk,
  serverInfoQuery,
} from '@/api/hooks';
import { queryClient } from '@/api/provider';
/* eslint-enable import/first */

function makeProgress(): Progress {
  return {
    library_id: 2,
    path: 'A/Book.m4b',
    position: 42,
    duration: 100,
    finished: false,
    playback_speed: 1,
    version: 0,
    device_id: 'dev',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/** An `ApiClient` stub whose only used method is `getProgress`. */
function clientThat(impl: () => Promise<Progress | null>): ApiClient {
  return { getProgress: jest.fn(impl) } as unknown as ApiClient;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMirroredProgress.mockResolvedValue(null);
});

describe('fetchBookProgress', () => {
  it('returns the server value on success', async () => {
    const p = makeProgress();
    const api = clientThat(async () => p);

    await expect(
      fetchBookProgress(api, 'c1', 2, 'A/Book.m4b', new AbortController().signal),
    ).resolves.toBe(p);
    expect(mockMirroredProgress).not.toHaveBeenCalled();
    expect(mockNoteError).not.toHaveBeenCalled();
  });

  // The reconnect invariant: a 401 has already flagged the connection via the client's
  // onAuthError, so resolving it as a query SUCCESS would let provider.tsx's
  // QueryCache.onSuccess clear the banner the same request just raised.
  it('rethrows a 401 ApiError instead of falling back to the mirror', async () => {
    const err = new ApiError(401, 'unauthorized');
    const api = clientThat(async () => {
      throw err;
    });

    await expect(
      fetchBookProgress(api, 'c1', 2, 'A/Book.m4b', new AbortController().signal),
    ).rejects.toBe(err);
    expect(mockMirroredProgress).not.toHaveBeenCalled();
    expect(mockNoteError).not.toHaveBeenCalled();
  });

  it('rethrows a 403 ApiError (a real answer, not an unreachable server)', async () => {
    const err = new ApiError(403, 'forbidden');
    const api = clientThat(async () => {
      throw err;
    });

    await expect(
      fetchBookProgress(api, 'c1', 2, 'A/Book.m4b', new AbortController().signal),
    ).rejects.toBe(err);
    expect(mockMirroredProgress).not.toHaveBeenCalled();
  });

  it('falls back to the mirror and notes reachability on a network failure', async () => {
    const mirrored = makeProgress();
    mockMirroredProgress.mockResolvedValue(mirrored);
    const err = new Error('Network request failed');
    const api = clientThat(async () => {
      throw err;
    });

    await expect(
      fetchBookProgress(api, 'c1', 2, 'A/Book.m4b', new AbortController().signal),
    ).resolves.toBe(mirrored);
    expect(mockMirroredProgress).toHaveBeenCalledWith('c1', 2, 'A/Book.m4b');
    expect(mockNoteError).toHaveBeenCalledWith('c1', err);
  });

  it('falls back to the mirror on a TimeoutError too', async () => {
    const err = new TimeoutError(1000);
    const api = clientThat(async () => {
      throw err;
    });

    await expect(
      fetchBookProgress(api, 'c1', 2, 'A/Book.m4b', new AbortController().signal),
    ).resolves.toBeNull();
    expect(mockNoteError).toHaveBeenCalledWith('c1', err);
  });

  it('rethrows on an aborted signal without touching the mirror', async () => {
    const controller = new AbortController();
    const err = new Error('Aborted');
    const api = clientThat(async () => {
      controller.abort();
      throw err;
    });

    await expect(fetchBookProgress(api, 'c1', 2, 'A/Book.m4b', controller.signal)).rejects.toBe(
      err,
    );
    expect(mockMirroredProgress).not.toHaveBeenCalled();
    expect(mockNoteError).not.toHaveBeenCalled();
  });
});

describe('qk.bookMeta', () => {
  // Each /meta request variant answers differently (`previous` added, or cut at the
  // caller's saved progress), so none may be served another's cached envelope.
  it('keys each request variant apart, under the plain key', () => {
    const plain = qk.bookMeta('c1', 2, 'A/Book');
    expect(plain).toEqual(['bookMeta', 'c1', 2, 'A/Book']);
    // No option set is the plain request (exactly `?path=`).
    expect(qk.bookMeta('c1', 2, 'A/Book', {})).toEqual(plain);
    expect(qk.bookMeta('c1', 2, 'A/Book', { includePrevious: false })).toEqual(plain);
    const variants = [
      qk.bookMeta('c1', 2, 'A/Book', { includePrevious: true }),
      qk.bookMeta('c1', 2, 'A/Book', { hideSpoilers: true }),
      qk.bookMeta('c1', 2, 'A/Book', { includePrevious: true, hideSpoilers: true }),
    ];
    expect(new Set(variants.map((k) => JSON.stringify(k))).size).toBe(3);
    // The plain key prefixes every variant, so invalidating it reaches them all.
    for (const k of variants) expect(k.slice(0, 4)).toEqual(plain);
  });
});

describe('anyCapability', () => {
  it('is true once any server has the flag, false once all are known without it', () => {
    expect(anyCapability({ a: { queue: true } as never, b: undefined }, 'queue')).toBe(true);
    expect(anyCapability({ a: {} as never, b: undefined }, 'queue')).toBeUndefined();
    expect(anyCapability({ a: {} as never, b: {} as never }, 'queue')).toBe(false);
    expect(anyCapability({}, 'queue')).toBeUndefined();
  });
});

describe('key predicates', () => {
  it('match their own key families', () => {
    expect(isQueueKey(qk.queue('c'))).toBe(true);
    expect(isQueueKey(qk.collections('c'))).toBe(false);
    expect(chaptersKeyParts(qk.chapters('c', 2, 'A/Book'))).toEqual({
      cid: 'c',
      libraryId: 2,
      path: 'A/Book',
    });
    expect(chaptersKeyParts(qk.item('c', 2, 'A/Book'))).toBeNull();
    expect(isSearchKey(qk.search('c', 'dune'), 'dune')).toBe(true);
    expect(isSearchKey(qk.search('c', 'dun'), 'dune')).toBe(false);
    expect(qk.allProgress('c').slice(0, 2)).toEqual([...qk.allProgressAll()]);
    expect(qk.recent('c', 48).slice(0, 2)).toEqual([...qk.recentAll()]);
  });
});

describe('addBookmark', () => {
  it("adds on the connection's own server and refreshes that book's bookmarks", async () => {
    const add = jest.fn(async () => ({ id: 7 }));
    mockResolveClient.mockReturnValue({ addBookmark: add });
    await expect(addBookmark('srv', 2, 'A/Book', 61, 'Fell asleep')).resolves.toEqual({ id: 7 });
    expect(mockResolveClient).toHaveBeenCalledWith('srv');
    expect(add).toHaveBeenCalledWith(2, 'A/Book', 61, 'Fell asleep');
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: qk.bookmarks('srv', 2, 'A/Book'),
    });
  });

  it('refreshes the across-books bookmarks too', async () => {
    mockResolveClient.mockReturnValue({ addBookmark: async () => ({ id: 7 }) });
    await addBookmark('srv', 2, 'A/Book', 61);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: qk.myBookmarks('srv'),
    });
  });

  describe('a label', () => {
    const caps = (annotations?: boolean) =>
      queryClient.setQueryData(qk.server('srv'), {
        capabilities: annotations === undefined ? {} : { annotations },
      } as ServerInfo);
    afterEach(() => queryClient.clear());

    it('is sent to a server with annotations', async () => {
      const add = jest.fn(async () => ({ id: 7 }));
      mockResolveClient.mockReturnValue({ addBookmark: add });
      caps(true);
      await addBookmark('srv', 2, 'A/Book', 61, 'Fell asleep', 'fell_asleep');
      expect(add).toHaveBeenCalledWith(2, 'A/Book', 61, 'Fell asleep', 'fell_asleep');
    });

    it('is dropped (the bookmark still made) without annotations, or before /server is known', async () => {
      const add = jest.fn(async () => ({ id: 7 }));
      mockResolveClient.mockReturnValue({ addBookmark: add });
      caps(false);
      await addBookmark('srv', 2, 'A/Book', 61, 'Fell asleep', 'fell_asleep');
      caps();
      await addBookmark('srv', 2, 'A/Book', 62, '', 'quote');
      queryClient.clear();
      await addBookmark('srv', 2, 'A/Book', 63, '', 'quote');
      expect(add.mock.calls).toEqual([
        [2, 'A/Book', 61, 'Fell asleep'],
        [2, 'A/Book', 62, ''],
        [2, 'A/Book', 63, ''],
      ]);
    });
  });

  it('rejects without touching the cache when the connection is gone or the add fails', async () => {
    mockResolveClient.mockReturnValue(null);
    await expect(addBookmark('gone', 2, 'A/Book', 61)).rejects.toThrow('connection gone');
    mockResolveClient.mockReturnValue({ addBookmark: async () => Promise.reject(new Error('x')) });
    await expect(addBookmark('srv', 2, 'A/Book', 61)).rejects.toThrow('x');
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });
});

describe('addNote', () => {
  it("pins the note on the connection's own server and refreshes both its lists", async () => {
    const add = jest.fn(async () => ({ id: 9 }));
    mockResolveClient.mockReturnValue({ addNote: add });
    await expect(addNote('srv', 2, 'A/Book', 'Theory', 61)).resolves.toEqual({ id: 9 });
    expect(add).toHaveBeenCalledWith(2, 'A/Book', 'Theory', 61);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: qk.notes('srv', 2, 'A/Book'),
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: qk.myNotes('srv') });
  });

  it('rejects without touching the cache when the connection is gone', async () => {
    mockResolveClient.mockReturnValue(null);
    await expect(addNote('gone', 2, 'A/Book', 'x', 0)).rejects.toThrow('connection gone');
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });
});

describe('across-books lists', () => {
  it("keeps the across-books history under the connection's history prefix", () => {
    // store.ts invalidates qk.historyAll after recording a span: it must reach this list.
    expect(qk.myHistory('c').slice(0, 2)).toEqual([...qk.historyAll('c')]);
  });

  it('flattens the pages so far, in order', () => {
    expect(flattenPages(undefined)).toEqual([]);
    expect(
      flattenPages({
        pages: [{ items: [1, 2], next_cursor: 'p2' }, { items: [3] }],
        pageParams: [undefined, 'p2'],
      }),
    ).toEqual([1, 2, 3]);
  });
});

describe('historyQuery', () => {
  it("keeps a limited read under the book's history key", () => {
    expect(historyQuery('srv', null, 2, 'A/Book').queryKey).toEqual(qk.history('srv', 2, 'A/Book'));
    expect(historyQuery('srv', null, 2, 'A/Book', 20).queryKey).toEqual([
      ...qk.history('srv', 2, 'A/Book'),
      20,
    ]);
  });
});

describe('read specs', () => {
  const client = {} as ApiClient;

  it('keeps a book’s chapters fresh for a long while: only a rescan changes them', () => {
    expect(chaptersQuery('c', client, 2, 'A/Book').staleTime).toBeGreaterThanOrEqual(10 * 60_000);
    expect(chaptersQuery('c', null, 2, 'A/Book').queryFn).toBe(skipToken);
  });

  it('reads community metadata on its key, long-lived but for the spoiler-cut variant', () => {
    const plain = bookMetaQuery('c', client, 2, 'A/Book');
    expect(plain.queryKey).toEqual(qk.bookMeta('c', 2, 'A/Book'));
    expect(plain).toMatchObject({ staleTime: META_STALE_MS, retry: false });
    const hidden = bookMetaQuery('c', client, 2, 'A/Book', { hideSpoilers: true });
    expect(hidden.queryKey).toEqual(qk.bookMeta('c', 2, 'A/Book', { hideSpoilers: true }));
    expect(hidden.staleTime).toBeUndefined();
    expect(bookMetaQuery('c', null, 2, 'A/Book').queryFn).toBe(skipToken);
    expect(bookMetaQuery('c', client, 2, '').queryFn).toBe(skipToken);
  });

  it('reads one meta work on its key, never without a client or an id', () => {
    expect(metaWorkQuery('c', client, 'w1')).toMatchObject({
      queryKey: qk.metaWork('c', 'w1'),
      staleTime: META_STALE_MS,
      retry: false,
    });
    expect(metaWorkQuery('c', null, 'w1').queryFn).toBe(skipToken);
    expect(metaWorkQuery('c', client, '').queryFn).toBe(skipToken);
  });
});

// The play path and the end of a book await this read and fall back when it fails, so it
// must settle: TanStack holds a fetch while the browser says it is offline, and a retry
// until a hidden tab is focused again.
describe('fetchCapabilities', () => {
  /** A `/server` answer with these flags. */
  const info = (capabilities: Partial<Capabilities>) => ({ capabilities }) as ServerInfo;
  /** A client whose `/server` read is `read`. */
  const serverAt = (read: () => Promise<ServerInfo>) => {
    const serverInfo = jest.fn(read);
    return { client: { serverInfo } as unknown as ApiClient, serverInfo };
  };
  /** `/server` flags read 10 minutes ago, past their 5 minutes of freshness. */
  const cacheStale = (capabilities: Partial<Capabilities>) =>
    queryClient.setQueryData(qk.server('c1'), info(capabilities), {
      updatedAt: Date.now() - 10 * 60_000,
    });
  /** Where a read stands once everything it can do by itself has run (a retry's back-off
   * included): its value, its error, or still `'pending'` (held, waiting on the browser). */
  async function settle<T>(read: Promise<T>) {
    const out: { now: { value: T } | { error: unknown } | 'pending' } = { now: 'pending' };
    read.then(
      (value) => (out.now = { value }),
      (error: unknown) => (out.now = { error }),
    );
    await jest.advanceTimersByTimeAsync(30_000);
    return out.now;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    queryClient.clear();
    onlineManager.setOnline(true);
    focusManager.setFocused(undefined);
    jest.useRealTimers();
  });

  it('asks while the browser says it is offline, falling back to the known flags', async () => {
    onlineManager.setOnline(false);
    cacheStale({ queue: true });
    const { client, serverInfo } = serverAt(() => Promise.reject(new TypeError('offline')));
    expect(await settle(fetchCapabilities('c1', client))).toEqual({ value: { queue: true } });
    expect(serverInfo).toHaveBeenCalledTimes(1);
  });

  it('gives the fresh flags when the server answers while the browser says offline', async () => {
    onlineManager.setOnline(false);
    cacheStale({ queue: true });
    const { client } = serverAt(async () => info({ queue: true, transcode: true }));
    expect(await settle(fetchCapabilities('c1', client))).toEqual({
      value: { queue: true, transcode: true },
    });
  });

  it('rejects at once in a hidden tab with nothing cached (a retry waits for focus)', async () => {
    focusManager.setFocused(false);
    const err = new TypeError('offline');
    const { client, serverInfo } = serverAt(() => Promise.reject(err));
    expect(await settle(fetchCapabilities('c1', client))).toEqual({ error: err });
    expect(serverInfo).toHaveBeenCalledTimes(1);
  });

  it('does not wait with the read a mounted hook has on hold', async () => {
    onlineManager.setOnline(false);
    cacheStale({ queue: true });
    const { client } = serverAt(async () => info({ queue: true, transcode: true }));
    // A capability hook mounted offline over the stale entry: its refetch waits for the
    // browser to come back online, and joining it would wait too.
    const stop = new QueryObserver(queryClient, serverInfoQuery('c1', client)).subscribe(() => {});
    expect(queryClient.getQueryState(qk.server('c1'))?.fetchStatus).toBe('paused');
    expect(await settle(fetchCapabilities('c1', client))).toEqual({
      value: { queue: true, transcode: true },
    });
    stop();
  });
});
