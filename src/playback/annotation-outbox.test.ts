import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiError, NetworkError, TimeoutError } from '@/api/client';
import type { Bookmark } from '@/api/types';

import { ANNOTATION_OUTBOX_KEY as KEY } from '@/lib/storage-keys';

import type { QueuedBookmark } from './annotation-outbox';

// The bookmark outbox (fe#356): what is kept, what is sent, once, in order, and what is
// dropped. The server is a mock client per connection; `addBookmark` (hooks.ts) posts
// through it, as the real one does through `resolveClient`.

type Client = { bookmarks: jest.Mock; addBookmark: jest.Mock; serverInfo: jest.Mock };
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
// The server's flags as the cache holds them: `undefined` while its `/server` is unread.
let mockAnnotations: boolean | undefined = true;
// Whether it takes a bookmark's `client_id` (`bookmark_client_id`), once its flags are read:
// false is an older server (the default here).
let mockClientIds = false;
// Its `/server` failing so (unread flags), while set.
let mockCapsDown: unknown = null;
const mockFetchCaps = jest.fn(async () => {
  if (mockCapsDown) throw mockCapsDown;
  mockAnnotations = true;
  return { annotations: true, bookmark_client_id: mockClientIds };
});
jest.mock('@/api/hooks', () => ({
  // As the real one: the label only to a server known to have `annotations`, the id only to
  // one known to have `bookmark_client_id`.
  addBookmark: (
    cid: string,
    lib: number,
    path: string,
    position: number,
    note = '',
    label?: string,
    clientId?: string,
  ) => {
    const client = mockClients.get(cid);
    if (!client) return Promise.reject(new Error('connection gone'));
    const withLabel = label !== undefined && mockAnnotations === true;
    if (clientId !== undefined && mockAnnotations !== undefined && mockClientIds) {
      return client.addBookmark(lib, path, position, note, withLabel ? label : undefined, clientId);
    }
    return withLabel
      ? client.addBookmark(lib, path, position, note, label)
      : client.addBookmark(lib, path, position, note);
  },
  cachedCapability: (_cid: string, flag: string) =>
    flag === 'bookmark_client_id' && mockAnnotations !== undefined
      ? mockClientIds
      : mockAnnotations,
  fetchCapabilities: () => mockFetchCaps(),
  showServerBookmark: (...args: unknown[]) => mockShowServerBookmark(...args),
}));
// The book's cached list taking a bookmark its server already holds.
const mockShowServerBookmark = jest.fn();
// A `/server` answer the outbox asked the server for itself becomes the cached flags, unless
// it names another server (a reset one: `mockOtherServer`), which says nothing of this one.
let mockOtherServer = false;
jest.mock('@/api/server-snapshots', () => ({
  keepServerAnswer: (_cid: string, info: { capabilities: Record<string, boolean> }) => {
    if (mockOtherServer) return false;
    mockAnnotations = !!info.capabilities.annotations;
    mockClientIds = !!info.capabilities.bookmark_client_id;
    return true;
  },
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
  heldOnServer,
  onQueuedBookmarksChange,
  queueNewBookmark,
  queuedBookmarks,
  queuedBookmarksSnapshot,
  requeueBookmark,
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

/** The outbox as stored, whatever the screens are shown. */
async function storedEntries(): Promise<QueuedBookmark[]> {
  return JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]');
}

/** A tap whose POST is out until `answer` is called (with nothing: it lands and answers;
 * with an error: it fails so). */
function heldPost(client: Client) {
  const send = client.addBookmark.getMockImplementation();
  let answer: (err?: unknown) => void = () => {};
  client.addBookmark.mockImplementationOnce(
    (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        answer = (err) => (err ? reject(err) : resolve(send?.(...args)));
      }),
  );
  return { answer: (err?: unknown) => answer(err) };
}

/** A server that keeps what it is sent, failing while `down`. A `client_id` it holds already
 * gets that bookmark back (its 200), as a server with `bookmark_client_id` does. */
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
      async (
        lib: number,
        path: string,
        position: number,
        note: string,
        label?: string,
        clientId?: string,
      ) => {
        if (state.down) throw state.down;
        const already = clientId && held.find((b) => b.client_id === clientId);
        if (already) return already;
        const made: Bookmark = {
          id: next++,
          library_id: lib,
          path,
          position,
          note,
          ...(label ? { label } : {}),
          ...(clientId ? { client_id: clientId } : {}),
          created_at: new Date().toISOString(),
        };
        held.push(made);
        return made;
      },
    ),
    // Its `/server`, asked directly: the flags it has now.
    serverInfo: jest.fn(async () => {
      if (state.down) throw state.down;
      return { capabilities: { annotations: true, bookmark_client_id: mockClientIds } };
    }),
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
  mockClientIds = false;
  mockCapsDown = null;
  mockOtherServer = false;
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

  it.each([
    ['an older server', true],
    ['a server whose flags are not read yet', undefined],
  ])('stores nothing before the POST of a tap to %s', async (_name, annotations) => {
    const { client } = server('c1');
    mockAnnotations = annotations;
    // Its POST out, with no answer yet: an older server makes a resend twice, so the add
    // keeps it only once that POST has failed.
    client.addBookmark.mockImplementationOnce(() => new Promise(() => {}));
    void addBookmarkOrQueue('c1', 1, 'a/book', 120);
    await idle();
    expect(client.addBookmark).toHaveBeenCalledWith(1, 'a/book', 120, '');
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
    // Shown in the book's list as a send's would be: its waiting row gives way to it.
    expect(mockShowServerBookmark).toHaveBeenCalledWith('c1', 1, 'a/book', held[0]);
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

  it("does not take another night's at the same place for a new one no send has reached", async () => {
    const { held } = server('c1');
    // The night before's, well within the day.
    held.push({
      id: 9,
      library_id: 1,
      path: 'a/book',
      position: 120,
      note: 'Fell asleep',
      created_at: new Date(Date.now() - 20 * 3_600_000).toISOString(),
    });
    await queueNewBookmark('c1', 1, 'a/book', 120, 'Fell asleep');
    await idle();
    expect(held.map((b) => b.id)).toEqual([9, 1]);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('takes a new one whose send landed with no answer as sent, beside an earlier one', async () => {
    const { client, held } = server('c1');
    held.push({
      id: 9,
      library_id: 1,
      path: 'a/book',
      position: 120,
      note: 'Fell asleep',
      created_at: new Date(Date.now() - 20 * 3_600_000).toISOString(),
    });
    // Its first send lands, but its answer is lost.
    const send = client.addBookmark.getMockImplementation();
    client.addBookmark.mockImplementationOnce(async (...args: unknown[]) => {
      await send?.(...args);
      throw new TimeoutError(15_000);
    });
    await queueNewBookmark('c1', 1, 'a/book', 120, 'Fell asleep');
    await idle();
    // Waiting, no longer fresh, for the screens too (its row gives way to what landed).
    const [waiting] = queuedBookmarksSnapshot();
    expect(waiting).toMatchObject({ position: 120, othersHeld: [9] });
    expect(waiting).not.toHaveProperty('fresh');
    await flushBookmarks();
    expect(client.addBookmark).toHaveBeenCalledTimes(1);
    expect(held.map((b) => b.id)).toEqual([9, 1]);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('sends a new one again after a send that failed, beside an earlier one at its place', async () => {
    const { client, held } = server('c1');
    held.push({
      id: 9,
      library_id: 1,
      path: 'a/book',
      position: 120,
      note: 'Fell asleep',
      created_at: new Date(Date.now() - 20 * 3_600_000).toISOString(),
    });
    client.addBookmark.mockRejectedValueOnce(new ApiError(500, 'boom'));
    await queueNewBookmark('c1', 1, 'a/book', 120, 'Fell asleep');
    await idle();
    await flushBookmarks();
    expect(client.addBookmark).toHaveBeenCalledTimes(2);
    expect(held.map((b) => b.id)).toEqual([9, 1]);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('posts a new one straight away, once, when the device cannot store it', async () => {
    const { client, held } = server('c1');
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('quota'));
    await queueNewBookmark('c1', 1, 'a/book', 120, 'Fell asleep', 'fell_asleep');
    expect(client.addBookmark).toHaveBeenCalledTimes(1);
    expect(held).toMatchObject([{ position: 120, label: 'fell_asleep' }]);
    expect(await queuedBookmarks()).toEqual([]);
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

  it('joins a send to every connection already out, so one failure counts once', async () => {
    const { client, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await idle();
    state.down = null;
    client.addBookmark.mockClear();
    client.bookmarks.mockClear();
    client.addBookmark.mockRejectedValue(new ApiError(500, 'boom'));
    // The web's `online` and `focus`, together.
    await Promise.all([flushBookmarks(), flushBookmarks()]);
    expect(client.bookmarks).toHaveBeenCalledTimes(1);
    expect(client.addBookmark).toHaveBeenCalledTimes(1);
    expect(await queuedBookmarks()).toMatchObject([{ position: 100, failures: 1 }]);
    // Once settled, the next ask sends again; its failure, so soon after, does not count.
    await flushBookmarks();
    expect(client.addBookmark).toHaveBeenCalledTimes(2);
    expect(await queuedBookmarks()).toMatchObject([{ position: 100, failures: 1 }]);
  });

  it("counts one failure once when a connection's own replay runs right behind a sweep", async () => {
    const { client, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await idle();
    state.down = null;
    client.addBookmark.mockClear();
    client.addBookmark.mockRejectedValue(new ApiError(500, 'boom'));
    // The web's focus (every connection) and the connection's reconnect: never joined, the
    // second replays behind the first and meets the same failure.
    await Promise.all([flushBookmarks(), flushBookmarks('c1')]);
    expect(client.addBookmark).toHaveBeenCalledTimes(2);
    const [entry] = await queuedBookmarks();
    expect(entry).toMatchObject({ failures: 1, failingStep: 'post' });
    expect(entry.lastFailure).toBe(entry.failedSince);
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

  it("sends the rest of a book's after a POST that answered with no bookmark", async () => {
    const { client, held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    await addBookmarkOrQueue('c1', 1, 'a/book', 200);
    await idle();
    state.down = null;
    client.addBookmark.mockClear();
    client.addBookmark.mockResolvedValueOnce(undefined);
    await flushBookmarks();
    expect(client.addBookmark).toHaveBeenCalledTimes(2);
    expect(held.map((b) => b.position)).toEqual([200]);
    expect(await queuedBookmarks()).toEqual([]);
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
    /** A spell of failing, a try `every` ms: by default the tries of an hour's backoff (each
     * at least `RETRY_MIN_MS` after the last, so each counts); a day apart (the app opened
     * once a day) keeps the run going. */
    async function failFor(tries: number, every = 30_000) {
      for (let i = 0; i < tries; i++) {
        jest.setSystemTime(Date.now() + every);
        await flushBookmarks();
      }
    }

    it('drops one still failing a week after its first failure, said in the log', async () => {
      const { client, held } = await waiting();
      const send = client.addBookmark.getMockImplementation();
      client.addBookmark.mockImplementation((...args: unknown[]) =>
        args[2] === 100 ? Promise.reject(new ApiError(500, 'boom')) : send?.(...args),
      );
      // Its first failures: kept, as on every try of the week after them.
      await failFor(10);
      expect(await positions()).toEqual([100, 200]);
      await failFor(6, DAY);
      expect(await positions()).toEqual([100, 200]);
      expect(warn).not.toHaveBeenCalled();
      // A week on: given up, and the one behind it (which never failed itself) goes.
      await failFor(1, DAY);
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
      await failFor(10);
      await failFor(6, DAY);
      expect(await positions()).toEqual([100, 200]);
      expect(warn).not.toHaveBeenCalled();
      client.bookmarks.mockClear();
      await failFor(1, DAY);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(await positions()).toEqual([]);
      // One read of the book told both.
      expect(client.bookmarks).toHaveBeenCalledTimes(1);
      expect(held.map((b) => b.position)).toEqual([300]);
    });

    it("drops a labelled one whose server's flags have not read for a week", async () => {
      const s = server('c1', offline());
      await queueNewBookmark('c1', 1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
      s.state.down = null;
      mockAnnotations = undefined;
      mockCapsDown = new ApiError(404, 'not found');
      await failFor(10);
      await failFor(6, DAY);
      expect(await positions()).toEqual([100]);
      expect(warn).not.toHaveBeenCalled();
      await failFor(1, DAY);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(await positions()).toEqual([]);
      expect(s.held).toEqual([]);
    });

    it("keeps a labelled one whose flags read said nothing of the server's (cancelled)", async () => {
      const s = server('c1', offline());
      await queueNewBookmark('c1', 1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
      s.state.down = null;
      mockAnnotations = undefined;
      // Not an answer: the shared `/server` read cancelled under it, as a send's no answer.
      mockCapsDown = Object.assign(new Error('cancelled'), { name: 'CancelledError' });
      await failFor(10);
      jest.setSystemTime(Date.now() + 8 * DAY);
      await flushBookmarks();
      expect(warn).not.toHaveBeenCalled();
      expect(await positions()).toEqual([100]);
      expect(s.held).toEqual([]);
    });

    it('keeps one that failed twice a week apart, with no try between', async () => {
      const { client, held } = await waiting();
      client.addBookmark.mockRejectedValueOnce(new ApiError(500, 'boom'));
      await flushBookmarks();
      // The app closed, or its server away, for more than the week.
      jest.setSystemTime(Date.now() + 8 * DAY);
      client.addBookmark.mockRejectedValueOnce(new ApiError(500, 'boom'));
      await flushBookmarks();
      expect(await positions()).toEqual([100, 200]);
      expect(warn).not.toHaveBeenCalled();
      await flushBookmarks();
      expect(held.map((b) => b.position)).toEqual([300, 100, 200]);
    });

    it('starts the count again after a long gap with no failure', async () => {
      const { client } = await waiting();
      const send = client.addBookmark.getMockImplementation();
      client.addBookmark.mockImplementation((...args: unknown[]) =>
        args[2] === 100 ? Promise.reject(new ApiError(500, 'boom')) : send?.(...args),
      );
      // One failed POST, then the app closed for 8 days, then an hour of 500s at the same
      // step: a fresh run, not the end of a week of failing.
      await failFor(1);
      jest.setSystemTime(Date.now() + 8 * DAY);
      await failFor(12);
      expect(warn).not.toHaveBeenCalled();
      const [entry] = await queuedBookmarks();
      expect(entry).toMatchObject({ position: 100, failures: 12, failingStep: 'post' });
      expect(Date.now() - Date.parse(entry.failedSince ?? '')).toBeLessThan(DAY);
    });

    it("starts again a run an older build stored, with no lastFailure, after a day's gap", async () => {
      const { client } = await waiting();
      client.addBookmark.mockRejectedValue(new ApiError(500, 'boom'));
      const [first, ...rest] = await queuedBookmarks();
      const old = {
        ...first,
        failedSince: new Date(Date.now() - 8 * DAY).toISOString(),
        failures: 20,
      };
      await AsyncStorage.setItem(KEY, JSON.stringify([old, ...rest]));
      resetAnnotationOutboxForTests();
      await failFor(1);
      expect(warn).not.toHaveBeenCalled();
      expect((await queuedBookmarks())[0]).toMatchObject({ position: 100, failures: 1 });
    });

    it.each([
      ['is away (a gateway 502)', new ApiError(502, 'bad gateway')],
      ['is busy (a 503)', new ApiError(503, 'busy')],
      ['gives no answer', offline()],
      ['refuses the token (a 401)', new ApiError(401, 'unauthorized')],
    ])('never gives up while the server %s', async (_name, err) => {
      const { state, held } = await waiting();
      state.down = err;
      await failFor(12);
      jest.setSystemTime(Date.now() + 30 * DAY);
      await flushBookmarks();
      expect(await positions()).toEqual([100, 200, 300]);
      expect(warn).not.toHaveBeenCalled();
      state.down = null;
      await flushBookmarks();
      expect(held.map((b) => b.position).sort()).toEqual([100, 200, 300]);
    });

    it('starts the count again once a send gets past where it failed', async () => {
      const { client } = server('c1');
      mockAnnotations = undefined;
      mockCapsDown = new ApiError(500, 'boom');
      mockOnline.c1 = false;
      await queueNewBookmark('c1', 1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
      mockOnline.c1 = true;
      // One old failure: its server's flags would not read.
      await failFor(1);
      expect(await queuedBookmarks()).toMatchObject([{ failures: 1, failingStep: 'flags' }]);
      // More than a week on, the flags read, and an hour of 500s on the POST.
      jest.setSystemTime(Date.now() + 8 * DAY);
      mockCapsDown = null;
      client.addBookmark.mockRejectedValue(new ApiError(500, 'boom'));
      await failFor(12);
      expect(warn).not.toHaveBeenCalled();
      const [entry] = await queuedBookmarks();
      expect(entry).toMatchObject({ position: 100, failures: 12, failingStep: 'post' });
      expect(Date.now() - Date.parse(entry.failedSince ?? '')).toBeLessThan(DAY);
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
    await queueNewBookmark('c1', 1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
    await idle(); // its own replay, against the server still down
    mockAnnotations = undefined;
    state.down = null;
    client.addBookmark.mockClear();
    await flushBookmarks();
    expect(mockFetchCaps).toHaveBeenCalledTimes(1);
    expect(client.addBookmark).toHaveBeenCalledWith(1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
  });

  it('keeps a labelled one, label and all, while the flags cannot be read', async () => {
    const { client, state } = server('c1', offline());
    await queueNewBookmark('c1', 1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
    await idle(); // its own replay, against the server still down
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

  it("lets the book's unlabelled ones past a labelled one waiting for its flags", async () => {
    const { client, held, state } = server('c1', offline());
    await queueNewBookmark('c1', 1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
    await addBookmarkOrQueue('c1', 1, 'a/book', 200);
    await idle();
    mockAnnotations = undefined;
    mockCapsDown = new ApiError(500, 'boom');
    state.down = null;
    client.addBookmark.mockClear();
    await flushBookmarks();
    expect(held.map((b) => b.position)).toEqual([200]);
    expect(await queuedBookmarks()).toMatchObject([{ position: 100, label: 'fell_asleep' }]);
  });

  it('sends a labelled one without its label to a server known not to take labels', async () => {
    const { client, state } = server('c1', offline());
    await queueNewBookmark('c1', 1, 'a/book', 100, 'Fell asleep', 'fell_asleep');
    await idle(); // its own replay, against the server still down
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
    const post = heldPost(client);
    const replaying = flushBookmarks();
    await idle();
    const second = (await queuedBookmarks()).find((e) => e.position === 200);
    expect(await discardQueuedBookmark(second?.id ?? '')).toMatchObject({ position: 200 });
    post.answer();
    await replaying;
    expect(held.map((b) => b.position)).toEqual([100]);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('puts one back through the outbox, so one sent just before its Delete is not made twice', async () => {
    const { client, held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100, 'n');
    await idle();
    state.down = null;
    // Its POST is on its way when its row is deleted.
    const post = heldPost(client);
    const replaying = flushBookmarks();
    await idle();
    const [entry] = await queuedBookmarks();
    const deleted = await discardQueuedBookmark(entry.id);
    expect(deleted).toMatchObject({ position: 100, note: 'n' });
    // Undo, then the POST lands after all.
    const back = requeueBookmark(deleted as QueuedBookmark);
    post.answer();
    await replaying;
    await back;
    await idle();
    expect(held.map((b) => b.position)).toEqual([100]);
    expect(await queuedBookmarks()).toEqual([]);
    // The Undo's entry, found already there, shows the server's bookmark in the list.
    expect(mockShowServerBookmark).toHaveBeenCalledWith('c1', 1, 'a/book', held[0]);
  });

  it('puts one back for a server that never got it, and sends it', async () => {
    const { held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    const [entry] = await queuedBookmarks();
    const deleted = (await discardQueuedBookmark(entry.id)) as QueuedBookmark;
    state.down = null;
    const back = await requeueBookmark(deleted);
    // A new entry, the same bookmark: its id for the server goes with it.
    expect(back).toMatchObject({ position: 100, client_id: entry.client_id });
    expect(back.id).not.toBe(entry.id);
    await idle();
    expect(held.map((b) => b.position)).toEqual([100]);
    await expect(requeueBookmark({ ...deleted, connectionId: 'gone' })).rejects.toThrow(
      'connection gone',
    );
  });

  it("does not take another night's at the same place for an Undo of one no send reached", async () => {
    const { held, state } = server('c1', offline());
    held.push({
      id: 9,
      library_id: 1,
      path: 'a/book',
      position: 120,
      note: 'Fell asleep',
      created_at: new Date(Date.now() - 20 * 3_600_000).toISOString(),
    });
    mockOnline.c1 = false;
    await queueNewBookmark('c1', 1, 'a/book', 120, 'Fell asleep');
    const [entry] = await queuedBookmarks();
    const deleted = (await discardQueuedBookmark(entry.id)) as QueuedBookmark;
    await requeueBookmark(deleted);
    // Still one no send has reached, on an older server too.
    expect(await queuedBookmarks()).toMatchObject([{ fresh: true }]);
    mockOnline.c1 = true;
    state.down = null;
    await flushBookmarks();
    expect(held.map((b) => b.id)).toEqual([9, 1]);
  });

  it('a pending one taken out unsent is never sent', async () => {
    const { held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 100);
    const [entry] = await queuedBookmarks();
    expect(await discardQueuedBookmark(entry.id)).toMatchObject({ id: entry.id });
    expect(await discardQueuedBookmark(entry.id)).toBeUndefined();
    state.down = null;
    await flushBookmarks();
    expect(held).toEqual([]);
  });
});

describe('to a server that takes a client_id (bookmark_client_id)', () => {
  beforeEach(() => {
    mockClientIds = true;
  });

  /** The server's bookmark POST lands, then its answer is lost (`times` times). */
  function loseAnswers(client: Client, err: unknown = new TimeoutError(15_000), times = 1) {
    const send = client.addBookmark.getMockImplementation();
    for (let i = 0; i < times; i++) {
      client.addBookmark.mockImplementationOnce(async (...args: unknown[]) => {
        await send?.(...args);
        throw err;
      });
    }
  }
  /** The `client_id` each POST carried. */
  const sentIds = (client: Client) => client.addBookmark.mock.calls.map((c) => c[5]);

  it('posts again after a lost answer, with no read first, and takes the 200 as held', async () => {
    const { client, held } = server('c1');
    loseAnswers(client);
    await queueNewBookmark('c1', 1, 'a/book', 120, 'Fell asleep', 'fell_asleep');
    await idle();
    const [entry] = await queuedBookmarks();
    // Still one no send without its id has reached: nothing at its place is taken for it.
    expect(entry).toMatchObject({ fresh: true, client_id: expect.any(String) });
    await flushBookmarks();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ label: 'fell_asleep', client_id: entry.client_id });
    expect(sentIds(client)).toEqual([entry.client_id, entry.client_id]);
    expect(client.bookmarks).not.toHaveBeenCalled();
    // The 200's bookmark settles it (`addBookmark` shows it in the book's list, as a 201's).
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('does not make one twice when storage refuses a write before its send', async () => {
    const { client, held } = server('c1');
    // The older servers' way writes `othersHeld` before a send: that write is refused.
    // The setup's storage mock, kept to put back.
    const setItem = jest.mocked(AsyncStorage.setItem);
    const store = setItem.getMockImplementation();
    setItem.mockImplementation((key, value) =>
      value.includes('othersHeld') || !store
        ? Promise.reject(new Error('quota'))
        : store(key, value),
    );
    try {
      loseAnswers(client);
      await queueNewBookmark('c1', 1, 'a/book', 120, 'Fell asleep');
      await idle();
      await flushBookmarks();
      expect(client.addBookmark).toHaveBeenCalledTimes(2);
      expect(held).toHaveLength(1);
      expect(await queuedBookmarks()).toEqual([]);
      // Its id makes the resend safe: no such write was even tried.
      expect(setItem.mock.calls.some(([, value]) => value.includes('othersHeld'))).toBe(false);
    } finally {
      if (store) setItem.mockImplementation(store);
    }
  });

  it('finds a tap sent bare before its flags were known, once they say ids are taken', async () => {
    const { client, held } = server('c1');
    // `/server` not read yet: the tap goes without its id, lands, and its answer is lost.
    mockAnnotations = undefined;
    loseAnswers(client);
    expect(await addBookmarkOrQueue('c1', 1, 'a/book', 120)).toHaveProperty('queued');
    expect(held[0]).not.toHaveProperty('client_id');
    expect((await queuedBookmarks())[0].fresh).toBeUndefined();
    await flushBookmarks();
    // The flags read now take ids, but the bare send may have landed: read first, found.
    expect(mockFetchCaps).toHaveBeenCalledTimes(1);
    expect(client.bookmarks).toHaveBeenCalledTimes(1);
    expect(client.addBookmark).toHaveBeenCalledTimes(1);
    expect(held).toHaveLength(1);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('waits when its flags answer again without ids between its decision and its POST', async () => {
    const { client, held } = server('c1');
    mockOnline.c1 = false;
    await queueNewBookmark('c1', 1, 'a/book', 120, 'Fell asleep');
    mockOnline.c1 = true;
    mockAnnotations = undefined;
    // The flags read says ids are taken; then, before the POST (at the storage read right
    // before it), they answer again without (a server rolled back).
    const getItem = jest.mocked(AsyncStorage.getItem);
    const read = getItem.getMockImplementation();
    mockFetchCaps.mockImplementationOnce(async () => {
      mockAnnotations = true;
      getItem.mockImplementationOnce(async (key) => {
        mockClientIds = false;
        return read ? read(key) : null;
      });
      return { annotations: true, bookmark_client_id: true };
    });
    // Whatever goes out next lands with no answer.
    loseAnswers(client, undefined, 2);
    await flushBookmarks();
    // Not sent bare with nothing stored for that.
    expect(client.addBookmark).not.toHaveBeenCalled();
    expect(await queuedBookmarks()).toMatchObject([{ position: 120, fresh: true }]);
    // The next replays go the older servers' way: sent once, then found.
    await flushBookmarks();
    await flushBookmarks();
    expect(held).toHaveLength(1);
    expect(await queuedBookmarks()).toEqual([]);
  });

  /** The server rolled back: it refuses the unknown field, and its `/server` has no such flag. */
  function rollBack(client: Client) {
    const send = client.addBookmark.getMockImplementation();
    client.addBookmark.mockImplementation((...args: unknown[]) =>
      args[5] === undefined
        ? send?.(...args)
        : Promise.reject(new ApiError(400, 'invalid request')),
    );
    client.serverInfo.mockResolvedValue({ capabilities: { annotations: true } });
  }

  it('keeps one whose id a server rolled back since its flags were read refuses', async () => {
    const { client, held } = server('c1');
    mockOnline.c1 = false;
    await queueNewBookmark('c1', 1, 'a/book', 120, 'n');
    await queueNewBookmark('c1', 1, 'b/book', 130, 'n');
    mockOnline.c1 = true;
    // The cached flags take ids (read a minute ago, still fresh there): the server itself is
    // asked, and says it does not.
    rollBack(client);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await flushBookmarks();
    expect(client.serverInfo).toHaveBeenCalledTimes(1);
    expect(mockFetchCaps).not.toHaveBeenCalled();
    // The refused one waits; the other book's, behind it, already goes without its id.
    expect(held.map((b) => b.position)).toEqual([130]);
    expect(await queuedBookmarks()).toMatchObject([{ position: 120 }]);
    expect((await queuedBookmarks())[0]).not.toHaveProperty('failures');
    await flushBookmarks();
    expect(held.map((b) => b.position)).toEqual([130, 120]);
    expect(held.some((b) => 'client_id' in b)).toBe(false);
    expect(await queuedBookmarks()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops one a 400 refuses while its server still takes ids', async () => {
    const { client, held } = server('c1');
    mockOnline.c1 = false;
    await queueNewBookmark('c1', 1, 'a/book', 120, 'n');
    mockOnline.c1 = true;
    client.addBookmark.mockRejectedValueOnce(new ApiError(400, 'invalid request'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await flushBookmarks();
    expect(client.serverInfo).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[bookmarks] the server refused a queued bookmark',
      expect.any(ApiError),
    );
    expect(held).toEqual([]);
    expect(await queuedBookmarks()).toEqual([]);
    warn.mockRestore();
  });

  it.each([
    ['fails', new ApiError(500, 'boom'), { failures: 1, failingStep: 'post' }],
    ['is busy', new ApiError(503, 'busy'), {}],
    // The connection's: the replay stops there.
    ['gives no answer', offline(), {}],
  ])(
    'never drops one a 400 refuses while its server, asked why, %s',
    async (_name, err, counted) => {
      const { client, held } = server('c1');
      mockOnline.c1 = false;
      await queueNewBookmark('c1', 1, 'a/book', 120, 'n');
      await queueNewBookmark('c1', 1, 'b/book', 130, 'n');
      mockOnline.c1 = true;
      rollBack(client);
      client.serverInfo.mockRejectedValueOnce(err);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await flushBookmarks();
      // Nothing known of the id yet: the 400 is not taken for the bookmark's own.
      expect(warn).not.toHaveBeenCalled();
      expect(held).toEqual([]);
      const [entry, other] = await queuedBookmarks();
      expect(entry).toMatchObject({ position: 120, ...counted });
      if (!('failures' in counted)) expect(entry).not.toHaveProperty('failures');
      expect(other).toMatchObject({ position: 130 });
      // Asked again, the server says it takes no ids: they go without.
      await flushBookmarks();
      await flushBookmarks();
      expect(held.map((b) => b.position).sort()).toEqual([120, 130]);
      expect(held.some((b) => 'client_id' in b)).toBe(false);
      expect(await queuedBookmarks()).toEqual([]);
      warn.mockRestore();
    },
  );

  it('keeps one a 400 refuses when another server answers at its address', async () => {
    const { client, held } = server('c1');
    mockOnline.c1 = false;
    await queueNewBookmark('c1', 1, 'a/book', 120, 'n');
    mockOnline.c1 = true;
    rollBack(client);
    // A reset server's `/server`: no answer about this connection's.
    mockOtherServer = true;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await flushBookmarks();
    expect(warn).not.toHaveBeenCalled();
    expect(held).toEqual([]);
    expect(await queuedBookmarks()).toMatchObject([{ position: 120 }]);
    warn.mockRestore();
  });

  it('keeps a tap whose id a rolled back server refuses, and sends it without', async () => {
    const { client, held } = server('c1');
    rollBack(client);
    // Not the bookmark's refusal: kept rather than failed, and sent at once on the new flags.
    expect(await addBookmarkOrQueue('c1', 1, 'a/book', 120)).toHaveProperty('queued');
    await idle();
    expect(client.serverInfo).toHaveBeenCalledTimes(1);
    expect(held).toMatchObject([{ position: 120 }]);
    expect(held[0]).not.toHaveProperty('client_id');
    expect(await queuedBookmarks()).toEqual([]);
    // The next tap goes straight there, bare.
    expect(await addBookmarkOrQueue('c1', 1, 'a/book', 130)).toHaveProperty('made');
  });

  it('stores a tap before its POST, out of sight, and takes it out once that works', async () => {
    const { client, held } = server('c1');
    const post = heldPost(client);
    const changed = jest.fn();
    const stop = onQueuedBookmarksChange(changed);
    const out = addBookmarkOrQueue('c1', 1, 'a/book', 120);
    await idle();
    // Stored, fresh with the id its POST carries...
    expect(await storedEntries()).toMatchObject([
      { position: 120, fresh: true, client_id: sentIds(client)[0] },
    ]);
    // ...but not waiting: no row, pin or count while its own POST is out.
    expect(queuedBookmarksSnapshot()).toEqual([]);
    expect(await queuedBookmarks()).toEqual([]);
    expect(await unsentBookmarks('c1')).toBe(0);
    // That replay (and any other from here) leaves it to the tap's POST.
    await flushBookmarks();
    expect(client.addBookmark).toHaveBeenCalledTimes(1);
    post.answer();
    expect(await out).toMatchObject({ made: { position: 120 } });
    expect(held).toHaveLength(1);
    expect(await storedEntries()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    stop();
  });

  it('shows a tap as waiting once its POST has failed, and sends it from there', async () => {
    const { client, held } = server('c1');
    const post = heldPost(client);
    const out = addBookmarkOrQueue('c1', 1, 'a/book', 120);
    await idle();
    expect(queuedBookmarksSnapshot()).toEqual([]);
    post.answer(new ApiError(500, 'boom'));
    const outcome = await out;
    expect(outcome).toMatchObject({ queued: { position: 120, fresh: true } });
    expect(queuedBookmarksSnapshot()).toMatchObject([{ position: 120 }]);
    expect(await queuedBookmarks('c1')).toHaveLength(1);
    await flushBookmarks();
    expect(held).toMatchObject([{ position: 120 }]);
    const [first, ...again] = sentIds(client);
    expect(again).toEqual([first]);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it.each([
    ['landed', true],
    ['never reached the server', false],
  ])('sends a tap killed mid-POST whose request %s again, once', async (_name, lands) => {
    const { client, held } = server('c1');
    const send = client.addBookmark.getMockImplementation();
    client.addBookmark.mockImplementationOnce(async (...args: unknown[]) => {
      if (lands) await send?.(...args);
      // The app killed: no answer ever comes.
      return new Promise(() => {});
    });
    void addBookmarkOrQueue('c1', 1, 'a/book', 120);
    await idle();
    expect(await queuedBookmarks()).toEqual([]);
    const [entry] = await storedEntries();
    expect(entry).toMatchObject({ position: 120, fresh: true, client_id: expect.any(String) });
    expect(sentIds(client)).toEqual([entry.client_id]);
    // The next launch: what was in memory is gone, the stored entry is not, and it waits.
    resetAnnotationOutboxForTests();
    expect(await queuedBookmarks()).toMatchObject([{ id: entry.id }]);
    expect(queuedBookmarksSnapshot()).toMatchObject([{ id: entry.id }]);
    await flushBookmarks();
    await flushBookmarks();
    expect(sentIds(client)).toEqual([entry.client_id, entry.client_id]);
    expect(client.bookmarks).not.toHaveBeenCalled();
    expect(held).toMatchObject([{ position: 120, client_id: entry.client_id }]);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it("makes it once when another tab's replay sends a tap whose POST is out", async () => {
    const { client, held } = server('c1');
    const post = heldPost(client);
    const out = addBookmarkOrQueue('c1', 1, 'a/book', 120);
    await idle();
    const [entry] = await storedEntries();
    // Another tab knows nothing of this one's POST: it sends the entry, with its id.
    await client.addBookmark(1, 'a/book', 120, '', undefined, entry.client_id);
    await AsyncStorage.setItem(KEY, '[]');
    post.answer();
    expect(await out).toHaveProperty('made');
    expect(held).toHaveLength(1);
    expect(await storedEntries()).toEqual([]);
  });

  it('posts a tap as before when storage refuses to keep it first', async () => {
    const { client, held } = server('c1');
    const setItem = jest.mocked(AsyncStorage.setItem);
    setItem.mockRejectedValueOnce(new Error('quota'));
    expect(await addBookmarkOrQueue('c1', 1, 'a/book', 120)).toHaveProperty('made');
    expect(sentIds(client)).toEqual([expect.any(String)]);
    expect(held).toHaveLength(1);
    expect(await storedEntries()).toEqual([]);
  });

  it('leaves a stored tap to the replay when its flags drop ids while it is stored', async () => {
    const { client, held } = server('c1');
    // A server rolled back: its flags answer again, without ids, while the tap is stored.
    const setItem = jest.mocked(AsyncStorage.setItem);
    const store = setItem.getMockImplementation();
    setItem.mockImplementationOnce(async (key, value) => {
      mockClientIds = false;
      return store?.(key, value);
    });
    // Never posted bare with nothing stored for it (`othersHeld`): the replay reads first.
    expect(await addBookmarkOrQueue('c1', 1, 'a/book', 120)).toHaveProperty('queued');
    await idle();
    expect(client.bookmarks).toHaveBeenCalledTimes(1);
    expect(sentIds(client)).toEqual([undefined]);
    expect(held).toHaveLength(1);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('fails a tap a 400 refuses while its server still takes ids', async () => {
    const { client } = server('c1');
    client.addBookmark.mockRejectedValueOnce(new ApiError(400, 'invalid request'));
    await expect(addBookmarkOrQueue('c1', 1, 'a/book', 120)).rejects.toBeInstanceOf(ApiError);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it("sends one again after a kill mid-send, once the dead replay's claim runs out", async () => {
    const { client, held } = server('c1');
    mockOnline.c1 = false;
    await queueNewBookmark('c1', 1, 'a/book', 120, 'Fell asleep');
    mockOnline.c1 = true;
    // The app was killed with its POST out: it landed, and the entry is still stored, fresh,
    // under the claim of a replay that no longer exists.
    const [entry] = await queuedBookmarks();
    await client.addBookmark(1, 'a/book', 120, 'Fell asleep', undefined, entry.client_id);
    client.addBookmark.mockClear();
    const claim = { id: 'dead', until: Date.now() + 30_000 };
    await AsyncStorage.setItem(KEY, JSON.stringify([{ ...entry, claim }]));
    resetAnnotationOutboxForTests();
    // The launch: left to the replay that claimed it.
    await flushBookmarks();
    expect(client.addBookmark).not.toHaveBeenCalled();
    expect(await queuedBookmarks()).toHaveLength(1);
    // Its claim run out: posted again with its id, the server's 200 settles it.
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try {
      await flushBookmarks();
    } finally {
      now.mockRestore();
    }
    expect(sentIds(client)).toEqual([entry.client_id]);
    expect(client.bookmarks).not.toHaveBeenCalled();
    expect(held).toHaveLength(1);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('keeps an Undo from making one a replay sent just before its Delete', async () => {
    const { client, held } = server('c1');
    loseAnswers(client);
    await queueNewBookmark('c1', 1, 'a/book', 120, 'Fell asleep');
    await idle();
    const [entry] = await queuedBookmarks();
    const deleted = (await discardQueuedBookmark(entry.id)) as QueuedBookmark;
    await requeueBookmark(deleted);
    await idle();
    expect(held).toHaveLength(1);
    expect(sentIds(client)).toEqual([entry.client_id, entry.client_id]);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it('sends both of two made in the same second with the same note', async () => {
    const { client, held } = server('c1');
    // Two at once (another tab's, or a second tap before the first is stored): the first's
    // add lands with no answer, the second's fails on the server.
    loseAnswers(client);
    client.addBookmark.mockRejectedValueOnce(new ApiError(500, 'boom'));
    const outcomes = await Promise.all([
      addBookmarkOrQueue('c1', 1, 'a/book', 120, 'n'),
      addBookmarkOrQueue('c1', 1, 'a/book', 120, 'n'),
    ]);
    expect(outcomes.every((o) => 'queued' in o)).toBe(true);
    expect(held).toHaveLength(1);
    await flushBookmarks();
    expect(held.map((b) => [b.position, b.note])).toEqual([
      [120, 'n'],
      [120, 'n'],
    ]);
    expect(new Set(held.map((b) => b.client_id)).size).toBe(2);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it.each([
    ['a 401', new ApiError(401, 'unauthorized')],
    ['a 429', new ApiError(429, 'slow down')],
  ])('does not take an earlier one at its place for a tap refused with %s', async (_n, err) => {
    const { client, held } = server('c1');
    held.push({
      id: 9,
      library_id: 1,
      path: 'a/book',
      position: 120,
      note: '',
      created_at: new Date(Date.now() - 3_600_000).toISOString(),
    });
    client.addBookmark.mockRejectedValueOnce(err);
    expect(await addBookmarkOrQueue('c1', 1, 'a/book', 120)).toHaveProperty('queued');
    await flushBookmarks();
    expect(held.map((b) => b.id)).toEqual([9, 1]);
    expect(await queuedBookmarks()).toEqual([]);
  });

  it("reads the server's flags first when they are not known, then sends the id", async () => {
    const { client, held, state } = server('c1', offline());
    mockOnline.c1 = false;
    await addBookmarkOrQueue('c1', 1, 'a/book', 120);
    mockOnline.c1 = true;
    mockAnnotations = undefined;
    state.down = null;
    await flushBookmarks();
    expect(mockFetchCaps).toHaveBeenCalledTimes(1);
    const [made] = held;
    expect(made.client_id).toEqual(expect.any(String));
    expect(client.bookmarks).not.toHaveBeenCalled();
  });

  it("goes the older servers' way while the flags cannot be read", async () => {
    const { client, held, state } = server('c1', offline());
    mockOnline.c1 = false;
    await addBookmarkOrQueue('c1', 1, 'a/book', 120);
    mockOnline.c1 = true;
    mockAnnotations = undefined;
    mockCapsDown = new ApiError(500, 'boom');
    state.down = null;
    await flushBookmarks();
    // No id sent where it is not known to be taken, and the book read first.
    expect(client.addBookmark).toHaveBeenCalledWith(1, 'a/book', 120, '');
    expect(client.bookmarks).toHaveBeenCalledTimes(1);
    expect(held).toHaveLength(1);
    expect(held[0]).not.toHaveProperty('client_id');
  });

  it('stops at a flags read with no answer, asking the server nothing more', async () => {
    const { client, state } = server('c1', offline());
    mockOnline.c1 = false;
    await addBookmarkOrQueue('c1', 1, 'a/book', 120);
    await addBookmarkOrQueue('c1', 1, 'b/book', 130);
    mockOnline.c1 = true;
    mockAnnotations = undefined;
    mockCapsDown = offline();
    state.down = null;
    await flushBookmarks();
    expect(mockFetchCaps).toHaveBeenCalledTimes(1);
    expect(client.bookmarks).not.toHaveBeenCalled();
    expect(client.addBookmark).not.toHaveBeenCalled();
    expect((await queuedBookmarks()).map((e) => e.position)).toEqual([120, 130]);
  });

  it("sends one an older build stored (no client_id) the older servers' way", async () => {
    const { client, held } = server('c1');
    held.push({
      id: 9,
      library_id: 1,
      path: 'a/book',
      position: 120,
      note: '',
      created_at: new Date().toISOString(),
    });
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: 'old',
          connectionId: 'c1',
          libraryId: 1,
          path: 'a/book',
          position: 120,
          note: '',
          updated_at: new Date().toISOString(),
        },
      ]),
    );
    await flushBookmarks();
    // Its add may have landed with no id to find it by: the one at its place is it.
    expect(client.bookmarks).toHaveBeenCalledTimes(1);
    expect(client.addBookmark).not.toHaveBeenCalled();
    expect(held.map((b) => b.id)).toEqual([9]);
  });

  it('keeps one stored with a failing step this build does not know, its count started again', async () => {
    const { client, held } = server('c1');
    const entry = {
      id: 'later',
      connectionId: 'c1',
      libraryId: 1,
      path: 'a/book',
      position: 120,
      note: '',
      updated_at: new Date().toISOString(),
      client_id: '6f1c2f0e-8a57-4d0b-9c5e-2f6f3f0a9b11',
      fresh: true,
      // A later build's, in the queue its tab shares with this one: ten failures over more
      // than the week, at a step with no place in this build's order.
      failedSince: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
      failures: 10,
      lastFailure: new Date(Date.now() - 60 * 60_000).toISOString(),
      failingStep: 'confirm',
    };
    await AsyncStorage.setItem(KEY, JSON.stringify([entry]));
    // Still waiting here, and a write of the queue (another bookmark stored) keeps it.
    mockOnline.c1 = false;
    await queueNewBookmark('c1', 1, 'b/book', 130, 'n');
    expect((await queuedBookmarks()).map((e) => e.position)).toEqual([120, 130]);
    mockOnline.c1 = true;
    // Its POST fails once more: not given up on by a count this build can't place.
    client.addBookmark.mockRejectedValueOnce(new ApiError(500, 'boom'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await flushBookmarks();
    expect(warn).not.toHaveBeenCalled();
    expect((await queuedBookmarks())[0]).toMatchObject({
      position: 120,
      failures: 1,
      failingStep: 'post',
    });
    await flushBookmarks();
    expect(held.map((b) => b.position).sort()).toEqual([120, 130]);
    expect(await queuedBookmarks()).toEqual([]);
    warn.mockRestore();
  });

  it('drops one whose client_id the server holds on another book, once, and sends the rest', async () => {
    const { client, held, state } = server('c1', offline());
    await queueNewBookmark('c1', 1, 'a/book', 100, 'n');
    await queueNewBookmark('c1', 1, 'a/book', 200, 'n');
    await idle();
    const [first] = await queuedBookmarks();
    state.down = null;
    client.addBookmark.mockClear();
    client.addBookmark.mockRejectedValueOnce(
      new ApiError(409, 'client_id names a bookmark on another book', 'client_id_conflict'),
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await flushBookmarks();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('client_id is on another book'));
    expect(held.map((b) => b.position)).toEqual([200]);
    expect(await queuedBookmarks()).toEqual([]);
    // Never sent again, under that id or a new one.
    await flushBookmarks();
    expect(sentIds(client).filter((id) => id === first.client_id)).toHaveLength(1);
    expect(client.addBookmark).toHaveBeenCalledTimes(2);
  });

  it('finds a waiting one on its server by its client_id alone', () => {
    const entry: QueuedBookmark = {
      id: 'e',
      connectionId: 'c1',
      libraryId: 1,
      path: 'a/book',
      position: 120,
      note: '',
      updated_at: new Date().toISOString(),
      client_id: 'k1',
      fresh: true,
    };
    const at = (id: number, client_id?: string): Bookmark => ({
      id,
      library_id: 1,
      path: 'a/book',
      position: 120,
      note: '',
      ...(client_id ? { client_id } : {}),
      created_at: new Date().toISOString(),
    });
    expect(heldOnServer(entry, [at(1), at(2, 'k2')])).toBeUndefined();
    expect(heldOnServer(entry, [at(1), at(3, 'k1')])?.id).toBe(3);
    // One a send without its id may have reached: one at its place made with no id, never
    // one made under another (another tap at the same second, another device's).
    const { fresh: _fresh, ...sentBare } = entry;
    expect(heldOnServer(sentBare, [at(2, 'k2')])).toBeUndefined();
    expect(heldOnServer(sentBare, [at(2, 'k2'), at(1)])?.id).toBe(1);
    const { client_id: _id, ...legacy } = sentBare;
    expect(heldOnServer(legacy, [at(2, 'k2')])).toBeUndefined();
    expect(heldOnServer({ ...sentBare, othersHeld: [] }, [at(2, 'k2')])).toBeUndefined();
  });
});

describe('to an older server', () => {
  it('sends no client_id and reads the book before each send', async () => {
    const { client, held, state } = server('c1', offline());
    await addBookmarkOrQueue('c1', 1, 'a/book', 120, 'n');
    state.down = null;
    await flushBookmarks();
    expect(client.addBookmark.mock.calls.map((c) => c.length)).toEqual([4, 4]);
    expect(client.bookmarks).toHaveBeenCalledTimes(1);
    expect(held[0]).not.toHaveProperty('client_id');
  });

  it.each([
    ['a 401', new ApiError(401, 'unauthorized')],
    ['a 429', new ApiError(429, 'slow down')],
  ])('does not take an earlier one at its place for a tap turned away with %s', async (_n, err) => {
    const { client, held } = server('c1');
    held.push({
      id: 9,
      library_id: 1,
      path: 'a/book',
      position: 120,
      note: '',
      created_at: new Date(Date.now() - 3_600_000).toISOString(),
    });
    client.addBookmark.mockRejectedValueOnce(err);
    expect(await addBookmarkOrQueue('c1', 1, 'a/book', 120)).toHaveProperty('queued');
    // Turned away before the server took it: no send of it has landed.
    expect(await queuedBookmarks()).toMatchObject([{ fresh: true }]);
    await flushBookmarks();
    expect(held.map((b) => b.id)).toEqual([9, 1]);
    expect(await queuedBookmarks()).toEqual([]);
  });
});

it("shows a waiting bookmark under its connection's new id once an identity move rewrote it", async () => {
  server('c1', offline());
  await addBookmarkOrQueue('c1', 1, 'a/book', 100);
  await idle();
  expect(queuedBookmarksSnapshot().map((e) => e.connectionId)).toEqual(['c1']);
  // The identity migration's rewrite: the same entry, its connection id moved.
  const stored = await storedEntries();
  await AsyncStorage.setItem(
    KEY,
    JSON.stringify(stored.map((e: object) => ({ ...e, connectionId: 'c1.7' }))),
  );
  await queuedBookmarks();
  expect(queuedBookmarksSnapshot().map((e) => e.connectionId)).toEqual(['c1.7']);
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

  it('does not wait behind a replay out for another server when none of its own wait', async () => {
    server('c1');
    const { client, state } = server('c2', offline());
    await addBookmarkOrQueue('c2', 1, 'a/book', 200);
    await idle();
    // c2's server stops answering: the replay sending its bookmark is out until it does.
    state.down = null;
    let answer: (held: Bookmark[]) => void = () => {};
    client.bookmarks.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const replaying = flushBookmarks();
    await idle();
    let sent = false;
    void sendBookmarksBeforeRemoval('c1').then(() => (sent = true));
    await idle();
    answer([]);
    expect(sent).toBe(true);
    await replaying;
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
