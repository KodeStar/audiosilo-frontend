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
// A connection a 401 flagged for signing in again (`needsReconnect`).
const mockFlagged = new Set<string>();
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (cid: string) => mockClients.get(cid) ?? null,
  connectionOf: (cid: string) =>
    mockClients.has(cid)
      ? { id: cid, needsReconnect: mockFlagged.has(cid) || undefined }
      : undefined,
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
// The session's changes `startBookmarkSync` follows (a connection signed in again).
type MockSession = { connections: { id: string; token: string; needsReconnect?: string }[] };
let mockSessionListener: ((state: MockSession, prev: MockSession) => void) | null = null;
jest.mock('@/stores/session', () => ({
  onConnectionRemoved: jest.fn(() => () => {}),
  useSession: {
    subscribe: (fn: (state: MockSession, prev: MockSession) => void) => {
      mockSessionListener = fn;
      return () => (mockSessionListener = null);
    },
  },
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
  unsentBookmarks,
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
  mockFlagged.clear();
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

  it('keeps a labelled one made while the flags cannot be read, instead of sending it bare', async () => {
    const { client } = server('c1');
    mockAnnotations = undefined;
    mockFetchCaps.mockRejectedValueOnce(new ApiError(500, 'boom'));
    const out = await addBookmarkOrQueue('c1', 1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
    expect(out).toMatchObject({ queued: { position: 100, label: 'fell_asleep' } });
    expect(client.addBookmark).not.toHaveBeenCalled();
    // The flags are read next time: it goes with its label.
    await flushBookmarks();
    expect(client.addBookmark).toHaveBeenCalledWith(1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
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

  it("does not hold a bookmark behind another book's still waiting", async () => {
    const { client, held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    state.down = null;
    client.bookmarks.mockClear();
    // Another book's goes straight to the server, as with nothing waiting.
    expect(await addBookmarkOrQueue('c1', 1, 'b/book', 200)).toHaveProperty('made');
    expect(client.bookmarks).not.toHaveBeenCalled();
    expect(held.map((b) => b.position)).toEqual([200]);
    expect((await queuedBookmarks()).map((e) => e.position)).toEqual([100]);
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

  it("stops at a failure that is the connection's and keeps it and those behind it", async () => {
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

  it.each([
    ['a 500', new ApiError(500, 'boom')],
    ['a 503', new ApiError(503, 'busy')],
  ])(
    "sends the other books' past one that fails with %s, and holds back the rest of its book",
    async (_name, err) => {
      const { client, held, state } = server('c1', offline());
      await addBookmarkOrQueue('c1', 1, 'a/book', 100);
      await addBookmarkOrQueue('c1', 1, 'b/book', 200);
      await addBookmarkOrQueue('c1', 1, 'a/book', 300);
      await addBookmarkOrQueue('c1', 1, 'c/book', 400);
      await idle();
      state.down = null;
      client.addBookmark.mockClear();
      // The first of a/book keeps failing.
      const send = client.addBookmark.getMockImplementation();
      client.addBookmark.mockImplementation((...args: unknown[]) =>
        args[2] === 100 ? Promise.reject(err) : send?.(...args),
      );
      await flushBookmarks();
      expect(held.map((b) => b.position)).toEqual([200, 400]);
      // a/book's second waits behind its first: never sent ahead of it.
      expect((await queuedBookmarks()).map((e) => e.position)).toEqual([100, 300]);
      await flushBookmarks();
      expect(held.map((b) => b.position)).toEqual([200, 400]);
      client.addBookmark.mockImplementation(send);
      await flushBookmarks();
      expect(held.map((b) => b.position)).toEqual([200, 400, 100, 300]);
      expect(await queuedBookmarks()).toEqual([]);
    },
  );

  it("sends the other books' past one whose read fails", async () => {
    const { client, held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await addBookmarkOrQueue('c1', 1, 'b/book', 200);
    await idle();
    state.down = null;
    const read = client.bookmarks.getMockImplementation();
    client.bookmarks.mockImplementation((...args: unknown[]) =>
      args[1] === 'a/book' ? Promise.reject(new ApiError(404, 'not found')) : read?.(...args),
    );
    await flushBookmarks();
    expect(held.map((b) => b.position)).toEqual([200]);
    expect((await queuedBookmarks()).map((e) => e.position)).toEqual([100]);
  });

  describe('giving up', () => {
    const DAY = 24 * 60 * 60_000;
    let warn: jest.SpyInstance;
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
      jest.useRealTimers();
    });

    /** Two bookmarks of one book and one of another, waiting for a server that is back. */
    async function waiting() {
      const s = server('c1', offline());
      mockOnline.c1 = false;
      await addBookmarkOrQueue('c1', 1, 'a/book', 100);
      await addBookmarkOrQueue('c1', 1, 'a/book', 200);
      await addBookmarkOrQueue('c1', 1, 'b/book', 300);
      mockOnline.c1 = true;
      s.state.down = null;
      return s;
    }
    const positions = async () => (await queuedBookmarks()).map((e) => e.position);

    it('drops one still failing a week after its first failure, said in the log', async () => {
      const { client, held } = await waiting();
      const send = client.addBookmark.getMockImplementation();
      client.addBookmark.mockImplementation((...args: unknown[]) =>
        args[2] === 100 ? Promise.reject(new ApiError(500, 'boom')) : send?.(...args),
      );
      // Its first failure: kept, as on every try of the week after it.
      await flushBookmarks();
      expect(await positions()).toEqual([100, 200]);
      jest.setSystemTime(Date.now() + 6 * DAY);
      await flushBookmarks();
      expect(await positions()).toEqual([100, 200]);
      expect(warn).not.toHaveBeenCalled();
      // A week on: given up, and the one behind it (which never failed itself) goes.
      jest.setSystemTime(Date.now() + 2 * DAY);
      await flushBookmarks();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(await positions()).toEqual([]);
      expect(held.map((b) => b.position)).toEqual([300, 200]);
    });

    it("drops a book's bookmarks whose read has failed for a week", async () => {
      const { client, held } = await waiting();
      const read = client.bookmarks.getMockImplementation();
      client.bookmarks.mockImplementation((...args: unknown[]) =>
        args[1] === 'a/book' ? Promise.reject(new ApiError(404, 'not found')) : read?.(...args),
      );
      await flushBookmarks();
      jest.setSystemTime(Date.now() + 6 * DAY);
      await flushBookmarks();
      expect(await positions()).toEqual([100, 200]);
      expect(warn).not.toHaveBeenCalled();
      client.bookmarks.mockClear();
      jest.setSystemTime(Date.now() + 2 * DAY);
      await flushBookmarks();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(await positions()).toEqual([]);
      // One read of the book told both.
      expect(client.bookmarks).toHaveBeenCalledTimes(1);
      expect(held.map((b) => b.position)).toEqual([300]);
    });

    it.each([
      ['is away (a gateway 502)', new ApiError(502, 'bad gateway')],
      ['is busy (a 503)', new ApiError(503, 'busy')],
      ['gives no answer', offline()],
      ['refuses the token (a 401)', new ApiError(401, 'unauthorized')],
    ])('never gives up while the server %s', async (_name, err) => {
      const { state, held } = await waiting();
      state.down = err;
      await flushBookmarks();
      jest.setSystemTime(Date.now() + 30 * DAY);
      await flushBookmarks();
      expect(await positions()).toEqual([100, 200, 300]);
      expect(warn).not.toHaveBeenCalled();
      state.down = null;
      await flushBookmarks();
      expect(held.map((b) => b.position).sort()).toEqual([100, 200, 300]);
    });
  });

  it.each([
    ['a 404', new ApiError(404, 'not found')],
    ['a 403', new ApiError(403, 'forbidden')],
  ])('keeps those whose read before the send fails with %s', async (_name, err) => {
    const { client, held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await addBookmarkOrQueue('c1', 1, 'a/book', 200);
    await idle();
    state.down = null;
    client.addBookmark.mockClear();
    client.bookmarks.mockRejectedValueOnce(err);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await flushBookmarks();
    // Nothing sent blind, nothing dropped.
    expect(client.addBookmark).not.toHaveBeenCalled();
    expect((await queuedBookmarks()).map((e) => e.position)).toEqual([100, 200]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    // The book reads again: they go, in order.
    await flushBookmarks();
    expect(held.map((b) => b.position)).toEqual([100, 200]);
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

  it('keeps a labelled one, label and all, while the flags cannot be read', async () => {
    const { client, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
    mockAnnotations = undefined;
    state.down = null;
    client.addBookmark.mockClear();
    mockFetchCaps.mockRejectedValueOnce(new ApiError(500, 'boom'));
    await flushBookmarks();
    // Not sent without its label: it waits for the flags.
    expect(client.addBookmark).not.toHaveBeenCalled();
    expect(await queuedBookmarks()).toMatchObject([{ position: 100, label: 'fell_asleep' }]);
    await flushBookmarks();
    expect(client.addBookmark).toHaveBeenCalledTimes(1);
    expect(client.addBookmark).toHaveBeenCalledWith(1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('sends a labelled one without its label to a server known not to take labels', async () => {
    const { client, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
    mockAnnotations = false;
    state.down = null;
    client.addBookmark.mockClear();
    await flushBookmarks();
    expect(mockFetchCaps).not.toHaveBeenCalled();
    expect(client.addBookmark).toHaveBeenCalledWith(1, 'a/book', 100, 'Fell asleep');
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

  it('does not send one taken out while the replay sends those ahead of it', async () => {
    const { client, held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await addBookmarkOrQueue('c1', 1, 'a/book', 200);
    await idle();
    state.down = null;
    // The first send is on its way when the second's row is deleted.
    let land: () => void = () => {};
    const send = client.addBookmark.getMockImplementation();
    client.addBookmark.mockImplementationOnce(
      (...args: unknown[]) => new Promise((resolve) => (land = () => resolve(send?.(...args)))),
    );
    const replaying = flushBookmarks();
    await idle();
    const second = (await queuedBookmarks()).find((e) => e.position === 200);
    expect(await discardQueuedBookmark(second?.id ?? '')).toBe(true);
    land();
    await replaying;
    expect(held.map((b) => b.position)).toEqual([100]);
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
  it('counts what still waits after a send to a reachable server (the confirm)', async () => {
    const { held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    expect(await unsentBookmarks('c1')).toBe(1);
    state.down = null;
    expect(await unsentBookmarks('c1')).toBe(0);
    expect(held).toHaveLength(1);
  });

  it('does not wait on a server known down before the confirm', async () => {
    const { client } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await idle();
    mockOnline.c1 = false;
    client.addBookmark.mockClear();
    client.bookmarks.mockClear();
    expect(await unsentBookmarks('c1')).toBe(1);
    expect(client.bookmarks).not.toHaveBeenCalled();
    expect(client.addBookmark).not.toHaveBeenCalled();
  });

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
  it('waits for a re-sign-in after a 401 instead of asking again on the backoff', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const { client, held, state } = server('c1', new ApiError(401, 'unauthorized'));
    const release = startBookmarkSync();
    try {
      mockFlagged.add('c1');
      await addBookmarkOrQueue('c1', 1, 'a/book', 100);
      client.bookmarks.mockClear();
      await jest.advanceTimersByTimeAsync(30 * 60_000);
      expect(client.bookmarks).not.toHaveBeenCalled();
      // Signed in again: a new token, the flag gone.
      mockFlagged.delete('c1');
      state.down = null;
      mockSessionListener?.(
        { connections: [{ id: 'c1', token: 'new' }] },
        { connections: [{ id: 'c1', token: 'old', needsReconnect: 'auth' }] },
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(held.map((b) => b.position)).toEqual([100]);
    } finally {
      release();
      jest.useRealTimers();
    }
  });

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
