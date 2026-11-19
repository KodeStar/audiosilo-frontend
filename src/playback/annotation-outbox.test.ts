import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiError, NetworkError, TimeoutError } from '@/api/client';
import type { Bookmark } from '@/api/types';

// The bookmark outbox (fe#356): what is kept, what is sent, once, in order, and what is
// dropped. The server is a mock client per connection; `addBookmark` (hooks.ts) posts
// through it, as the real one does through `resolveClient`.

type Client = { bookmarks: jest.Mock; addBookmark: jest.Mock };
const mockClients = new Map<string, Client>();
let mockReady = true;
let mockLaunch: (() => void) | null = null;
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (cid: string) => mockClients.get(cid) ?? null,
  sessionReady: () => mockReady,
  whenSessionReady: (fn: () => void) => {
    mockLaunch = fn;
    return () => (mockLaunch = null);
  },
}));
// A removal ends the connection's sign-in first (the listening outbox's count).
const mockGenerations = new Map<string, number>();
jest.mock('./listening-outbox', () => ({
  connectionGeneration: (cid: string) => mockGenerations.get(cid) ?? 0,
}));
const mockOnline: Record<string, boolean> = {};
let mockReconnect: ((cid: string) => void) | null = null;
jest.mock('@/api/reachability', () => ({
  isReachable: (cid: string) => mockOnline[cid] ?? true,
  noteFailure: () => {},
  onReconnect: (cb: (cid: string) => void) => {
    mockReconnect = cb;
    return () => (mockReconnect = null);
  },
}));
let mockAnnotations: boolean | undefined = true;
const mockFetchCaps = jest.fn(async () => {
  mockAnnotations = true;
  return { annotations: true };
});
jest.mock('@/api/hooks', () => ({
  // As the real one: the label only to a server known to have `annotations`.
  addBookmark: (
    cid: string,
    lib: number,
    path: string,
    position: number,
    note = '',
    label?: string,
  ) => {
    const client = mockClients.get(cid);
    if (!client) return Promise.reject(new Error('connection gone'));
    return label !== undefined && mockAnnotations === true
      ? client.addBookmark(lib, path, position, note, label)
      : client.addBookmark(lib, path, position, note);
  },
  cachedCapability: () => mockAnnotations,
  fetchCapabilities: () => mockFetchCaps(),
}));
jest.mock('@/stores/session', () => ({
  onConnectionRemoved: jest.fn(() => () => {}),
}));

/* eslint-disable import/first */
import {
  addBookmarkOrQueue,
  discardQueuedBookmark,
  flushBookmarks,
  queuedBookmarks,
  queuedBookmarksSnapshot,
  resetAnnotationOutboxForTests,
  sendBookmarksBeforeRemoval,
  startBookmarkSync,
} from './annotation-outbox';
import { onConnectionRemoved } from '@/stores/session';
/* eslint-enable import/first */

/** The removal cleanups registered when the modules loaded (the outbox's purge among them). */
const cleanups = jest.mocked(onConnectionRemoved).mock.calls.map(([fn]) => fn);

/** Remove a connection as the session does: its sign-in ends, then the cleanups run. */
async function removed(id: string) {
  mockGenerations.set(id, (mockGenerations.get(id) ?? 0) + 1);
  await Promise.all(cleanups.map((fn) => fn(id)));
}

/** Let the replays an add started in the background finish. */
async function idle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A server that keeps what it is sent, failing while `down`. */
function server(cid: string, down: unknown = null) {
  const held: Bookmark[] = [];
  const state = { down };
  let next = 1;
  const client: Client = {
    bookmarks: jest.fn(async (lib: number, path: string) => {
      if (state.down) throw state.down;
      return held.filter((b) => b.library_id === lib && b.path === path);
    }),
    addBookmark: jest.fn(
      async (lib: number, path: string, position: number, note: string, label?: string) => {
        if (state.down) throw state.down;
        const made: Bookmark = {
          id: next++,
          library_id: lib,
          path,
          position,
          note,
          ...(label ? { label } : {}),
          created_at: new Date().toISOString(),
        };
        held.push(made);
        return made;
      },
    ),
  };
  mockClients.set(cid, client);
  return { client, held, state };
}

const offline = () => new NetworkError(new TypeError('Failed to fetch'));

beforeEach(async () => {
  jest.clearAllMocks();
  resetAnnotationOutboxForTests();
  mockClients.clear();
  for (const k of Object.keys(mockOnline)) delete mockOnline[k];
  mockReady = true;
  mockAnnotations = true;
  mockGenerations.clear();
  await AsyncStorage.clear();
});

afterEach(() => resetAnnotationOutboxForTests());

describe('adding', () => {
  it('goes straight to a reachable server with nothing waiting', async () => {
    const { client } = server('c1');
    const out = await addBookmarkOrQueue('c1', 1, 'a/book', 120);
    expect(out).toMatchObject({ made: { id: 1, position: 120 } });
    expect(client.addBookmark).toHaveBeenCalledTimes(1);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('keeps a bookmark made offline and sends it once when the server is back', async () => {
    const { client, held, state } = server('c1', offline());
    const out = await addBookmarkOrQueue('c1', 1, 'a/book', 120, 'a note');
    expect(out).toMatchObject({
      queued: { connectionId: 'c1', libraryId: 1, path: 'a/book', position: 120, note: 'a note' },
    });
    expect(await queuedBookmarks('c1')).toHaveLength(1);
    expect(queuedBookmarksSnapshot()).toHaveLength(1);

    state.down = null;
    await flushBookmarks('c1');
    await flushBookmarks('c1');
    expect(held.map((b) => [b.position, b.note])).toEqual([[120, 'a note']]);
    // The failed try, then the replay's one send.
    expect(client.addBookmark).toHaveBeenCalledTimes(2);
    expect(await queuedBookmarks()).toEqual([]);
    expect(queuedBookmarksSnapshot()).toEqual([]);
  });

  it('keeps one made while the server is known to be down without asking it', async () => {
    const { client } = server('c1');
    mockOnline.c1 = false;
    expect(await addBookmarkOrQueue('c1', 1, 'a/book', 120)).toHaveProperty('queued');
    expect(client.addBookmark).not.toHaveBeenCalled();
    // A replay while it still reads down sends nothing.
    await flushBookmarks();
    expect(client.addBookmark).not.toHaveBeenCalled();
    expect(await queuedBookmarks('c1')).toHaveLength(1);
  });

  it.each([
    ['a 503', new ApiError(503, 'busy')],
    ['a 429', new ApiError(429, 'slow down')],
    ['a 401 (sign in again)', new ApiError(401, 'unauthorized')],
    ['a timeout', new TimeoutError(15_000)],
  ])('keeps one the server failed with %s', async (_name, err) => {
    server('c1', err);
    expect(await addBookmarkOrQueue('c1', 1, 'a/book', 120)).toHaveProperty('queued');
  });

  it.each([
    ['a 404 (the book is gone)', new ApiError(404, 'not found')],
    ['a 400', new ApiError(400, 'bad request')],
    ['a code bug', new Error('boom')],
  ])('refuses one the server refused for good: %s', async (_name, err) => {
    server('c1', err);
    await expect(addBookmarkOrQueue('c1', 1, 'a/book', 120)).rejects.toBe(err);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('refuses one for a connection that is gone', async () => {
    await expect(addBookmarkOrQueue('gone', 1, 'a/book', 120)).rejects.toThrow('connection gone');
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('puts a new one behind those waiting, so they reach the server in order', async () => {
    const { held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await addBookmarkOrQueue('c1', 1, 'b/book', 200);
    state.down = null;
    // The server is back, but one still waits: the new one goes behind it.
    const out = await addBookmarkOrQueue('c1', 1, 'a/book', 300);
    expect(out).toHaveProperty('queued');
    await idle();
    await flushBookmarks();
    expect(held.map((b) => b.position)).toEqual([100, 200, 300]);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it("does not hold one connection's bookmark behind another's", async () => {
    server('c1', offline());
    const two = server('c2');
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    expect(await addBookmarkOrQueue('c2', 1, 'a/book', 200)).toHaveProperty('made');
    expect(two.held).toHaveLength(1);
  });

  it('fails, keeping nothing, when the device cannot store it', async () => {
    server('c1', offline());
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('quota'));
    await expect(addBookmarkOrQueue('c1', 1, 'a/book', 120)).rejects.toThrow('quota');
    expect(await queuedBookmarks()).toEqual([]);
  });
});

describe('sending', () => {
  it('takes one the server already holds (an add whose answer was lost) as sent', async () => {
    const { client, held, state } = server('c1', new TimeoutError(15_000));
    await addBookmarkOrQueue('c1', 1, 'a/book', 120, 'n');
    // The timed-out add had landed after all.
    held.push({
      id: 9,
      library_id: 1,
      path: 'a/book',
      position: 120,
      note: 'n',
      created_at: new Date().toISOString(),
    });
    state.down = null;
    client.addBookmark.mockClear();
    await flushBookmarks();
    expect(client.addBookmark).not.toHaveBeenCalled();
    expect(held).toHaveLength(1);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('does not take a bookmark from long before at the same place as this one', async () => {
    const { held, state } = server('c1', offline());
    held.push({
      id: 9,
      library_id: 1,
      path: 'a/book',
      position: 120,
      note: '',
      created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    await addBookmarkOrQueue('c1', 1, 'a/book', 120);
    state.down = null;
    await flushBookmarks();
    expect(held).toHaveLength(2);
  });

  it('sends each once when two replays run at once (another tab)', async () => {
    const { client, held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await addBookmarkOrQueue('c1', 1, 'a/book', 200);
    state.down = null;
    client.addBookmark.mockClear();
    await Promise.all([flushBookmarks(), flushBookmarks(), flushBookmarks('c1')]);
    expect(client.addBookmark).toHaveBeenCalledTimes(2);
    expect(held.map((b) => b.position)).toEqual([100, 200]);
  });

  it('stops at the first that fails and keeps it and those behind it', async () => {
    const { client, held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await addBookmarkOrQueue('c1', 1, 'a/book', 200);
    await idle(); // the second add's own send has failed too
    state.down = null;
    client.addBookmark.mockClear();
    client.addBookmark.mockRejectedValueOnce(new ApiError(502, 'bad gateway'));
    await flushBookmarks();
    expect(client.addBookmark).toHaveBeenCalledTimes(1);
    expect((await queuedBookmarks()).map((e) => e.position)).toEqual([100, 200]);
    await flushBookmarks();
    expect(held.map((b) => b.position)).toEqual([100, 200]);
  });

  it('drops one the server refuses for good and sends the rest', async () => {
    const { client, held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await addBookmarkOrQueue('c1', 1, 'a/book', 200);
    state.down = null;
    client.addBookmark.mockClear();
    client.addBookmark.mockRejectedValueOnce(new ApiError(404, 'gone'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await idle();
    await flushBookmarks();
    expect(held.map((b) => b.position)).toEqual([200]);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('keeps those a 401 refuses: the connection signs in again and they go then', async () => {
    const { state, held } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    state.down = new ApiError(401, 'unauthorized');
    await flushBookmarks();
    expect(await queuedBookmarks()).toHaveLength(1);
    state.down = null;
    await flushBookmarks();
    expect(held).toHaveLength(1);
  });

  it("reads the server's flags first when they are not known, so a label is not lost", async () => {
    const { client, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
    mockAnnotations = undefined;
    state.down = null;
    client.addBookmark.mockClear();
    await flushBookmarks();
    expect(mockFetchCaps).toHaveBeenCalledTimes(1);
    expect(client.addBookmark).toHaveBeenCalledWith(1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
  });

  it('drops the bookmarks of a connection gone once the session has loaded', async () => {
    server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    mockClients.delete('c1');
    mockReady = false;
    await flushBookmarks();
    expect(await queuedBookmarks()).toHaveLength(1);
    mockReady = true;
    await flushBookmarks();
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('a pending one taken out unsent is never sent', async () => {
    const { held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    const [entry] = await queuedBookmarks();
    expect(await discardQueuedBookmark(entry.id)).toBe(true);
    expect(await discardQueuedBookmark(entry.id)).toBe(false);
    state.down = null;
    await flushBookmarks();
    expect(held).toEqual([]);
  });
});

describe('sign-out and removal', () => {
  it('sends what waits whatever the recorded reachability', async () => {
    const { held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    mockOnline.c1 = false;
    state.down = null;
    await sendBookmarksBeforeRemoval('c1');
    expect(held).toHaveLength(1);
    expect(await queuedBookmarks('c1')).toEqual([]);
  });

  it('keeps those the last send could not land (the removal purges them)', async () => {
    server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await sendBookmarksBeforeRemoval('c1');
    expect(await queuedBookmarks('c1')).toHaveLength(1);
  });

  it("drops a removed connection's bookmarks and keeps the others'", async () => {
    server('c1', offline());
    server('c2', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await addBookmarkOrQueue('c2', 1, 'a/book', 200);
    await removed('c1');
    expect((await queuedBookmarks()).map((e) => e.connectionId)).toEqual(['c2']);
  });

  it('does not keep one made before the removal and stored after it', async () => {
    server('c1', offline());
    // Its add is on its way (no answer yet) when the connection is removed.
    let fail: (e: unknown) => void = () => {};
    mockClients
      .get('c1')
      ?.addBookmark.mockImplementationOnce(
        () => new Promise((_resolve, reject) => (fail = reject)),
      );
    // Read once, so the add goes straight to the server.
    await queuedBookmarks();
    const adding = addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await Promise.resolve();
    await removed('c1');
    fail(offline());
    await expect(adding).rejects.toThrow('connection gone');
    expect(await queuedBookmarks()).toEqual([]);
  });
});

describe('startBookmarkSync', () => {
  it('sends at launch and when a server comes back', async () => {
    const { held, state } = server('c1', offline());
    // Made while the server is known down: kept, nothing sent.
    mockOnline.c1 = false;
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    mockOnline.c1 = true;
    state.down = null;
    const release = startBookmarkSync();
    try {
      // The launch, once the session is ready.
      expect(mockLaunch).not.toBeNull();
      mockLaunch?.();
      await idle();
      expect(held.map((b) => b.position)).toEqual([100]);
      mockOnline.c1 = false;
      await addBookmarkOrQueue('c1', 1, 'a/book', 300);
      await idle();
      expect(held.map((b) => b.position)).toEqual([100]);
      // Its server comes back.
      mockOnline.c1 = true;
      mockReconnect?.('c1');
      await idle();
      expect(held.map((b) => b.position)).toEqual([100, 300]);
    } finally {
      release();
    }
  });
});
