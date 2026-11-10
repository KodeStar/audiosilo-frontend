import { Platform } from 'react-native';

import type { ListeningEvent, ListeningSyncRequest } from '@/api/types';
import { fakeBrowser, type FakeTab, sleep, until } from '@/testing/fake-browser';

// The listening outbox across the tabs of the web player (fe#123, fe#211): each tab is its
// own copy of the module (`jest.isolateModules`), with its own memory and its own client,
// over one browser's shared storage (`fakeBrowser`). What one tab knows only in memory
// (which requests are out, what was taken back, what a request carried) another tab can
// only read from the stored outbox.

/** The tab whose modules are being loaded: each mock factory below runs once per tab. */
let mockTab: FakeTab;
/** The client the tab being loaded gets. */
let mockClient: { syncListening: jest.Mock; serverInfo: jest.Mock; saveProgress: jest.Mock };
/** Whether the server looks reachable (to every tab). */
let mockReachable = true;
/** Held open by a test, a send waits here between reading its chunk and going out. */
let mockBeforeSend: Promise<void> | null = null;

jest.mock('@/lib/storage', () => {
  // The web's storage is the browser's `localStorage`: each tab's copy reads and writes its
  // own tab's, so a write tells the OTHER tabs.
  const { tabStorage } = jest.requireActual('@/testing/fake-browser');
  return { ...jest.requireActual('@/lib/storage'), ...tabStorage(mockTab.localStorage) };
});
jest.mock('@/api/reachability', () => ({
  isReachable: () => mockReachable,
  noteFailure: jest.fn(),
  noteSuccess: jest.fn(),
}));
jest.mock('@/api/connection-clients', () => {
  const client = mockClient;
  return { resolveClient: () => client, sessionReady: () => true };
});
jest.mock('@/stores/session', () => ({ onConnectionRemoved: jest.fn(() => () => {}) }));
jest.mock('@/api/hooks', () => ({
  cachedCapability: () => true,
  qk: {
    progress: (cid: string, lib: number, path: string) => ['progress', cid, lib, path],
    historyAll: (cid: string) => ['history', cid],
    server: (cid: string) => ['server', cid],
  },
}));
jest.mock('@/api/provider', () => ({
  queryClient: { setQueryData: jest.fn(), invalidateQueries: jest.fn(async () => {}) },
}));
jest.mock('./progress-sync', () => ({
  ...jest.requireActual('./progress-sync'),
  // The last wait before a chunk goes out (`sendChunk`).
  getDeviceId: async () => {
    await mockBeforeSend;
    return 'dev-1';
  },
}));

const OUTBOX = 'audiosilo.listeningOutbox';
const OPEN_SPAN = 'audiosilo.listeningOpenSpan';

type Sync = (body: ListeningSyncRequest, opts?: { keepalive?: boolean }) => Promise<unknown>;
const applied: Sync = async (body) => ({
  server_time: new Date().toISOString(),
  results: body.events.map((e) => ({ id: e.id, status: 'applied' })),
  progress: [],
});
/** A request that gets no answer. */
const lost: Sync = async () => {
  throw new TypeError('Failed to fetch');
};
/** `then`, once the gate `open` is resolved: a request that is out until the test lets it end. */
const after =
  (open: { promise: Promise<void> }, then: Sync): Sync =>
  async (body, opts) => {
    await open.promise;
    return then(body, opts);
  };

type Tab = ReturnType<typeof openTab>;

/** Open a tab of `browser`: its own copy of the outbox, with a client that answers
 * `applied` until the test says otherwise (`sync`). */
function openTab(browser: ReturnType<typeof fakeBrowser>) {
  const tab = browser.tab();
  const client = {
    syncListening: jest.fn(applied),
    serverInfo: jest.fn(async () => ({ capabilities: { listening_sync: true } })),
    saveProgress: jest.fn(async () => ({})),
  };
  mockTab = tab;
  mockClient = client;
  // The outbox follows the other tabs through the window's `storage` events.
  const g = globalThis as Record<string, unknown>;
  const before = { add: g.addEventListener, remove: g.removeEventListener };
  g.addEventListener = tab.addEventListener;
  g.removeEventListener = tab.removeEventListener;
  let outbox!: typeof import('./listening-outbox');
  let api!: typeof import('@/api/client');
  try {
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      outbox = require('./listening-outbox') as typeof import('./listening-outbox');
      api = require('@/api/client') as typeof import('@/api/client');
      /* eslint-enable @typescript-eslint/no-require-imports */
    });
  } finally {
    g.addEventListener = before.add;
    g.removeEventListener = before.remove;
  }
  return {
    ...outbox,
    tab,
    client,
    /** Answer this tab's sends with `fn` from here on. */
    sync: (fn: Sync) => client.syncListening.mockImplementation(fn),
    /** The server's own refusal, as this tab's copy of the client throws it. */
    refusal: (status: number) => new api.ApiError(status, 'refused'),
    /** The ids each of this tab's requests carried. */
    sent: () =>
      client.syncListening.mock.calls.map((c) =>
        (c[0] as ListeningSyncRequest).events.map((e) => e.id),
      ),
  };
}

const finish = (id: string, path = 'Author/Book') =>
  ({ id, kind: 'finish', library_id: 3, path, at: new Date().toISOString() }) as ListeningEvent;
const listen = (id: string) =>
  ({
    id,
    kind: 'listen',
    library_id: 3,
    path: 'Author/Book',
    from_pos: 10,
    to_pos: 40,
    started_at: new Date(Date.now() - 30_000).toISOString(),
    ended_at: new Date().toISOString(),
    start: 'resume',
  }) as ListeningEvent;

// Real timers and real locks between the tabs: room for a loaded CI machine.
jest.setTimeout(20_000);

/** A promise a test settles by hand. */
function gate<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Stored = { connectionId: string; event: ListeningEvent } & Record<string, unknown>;

let browser: ReturnType<typeof fakeBrowser>;
let a: Tab;
let b: Tab;
const stored = (): Stored[] => JSON.parse(browser.data.get(OUTBOX) ?? '[]') as Stored[];
const storedIds = () => stored().map((e) => e.event.id);

const os = Platform.OS;
const g = globalThis as Record<string, unknown>;
const hadStorage = g.localStorage;
beforeAll(() => {
  Platform.OS = 'web';
});
afterAll(() => {
  Platform.OS = os;
  g.localStorage = hadStorage;
});
beforeEach(() => {
  mockReachable = true;
  mockBeforeSend = null;
  browser = fakeBrowser();
  a = openTab(browser);
  b = openTab(browser);
  // The window's `localStorage` (a page that is going reads the outbox from it at once).
  g.localStorage = browser.tab().localStorage;
});
afterEach(async () => {
  // Every send over before the file's modules go.
  mockBeforeSend = null;
  for (const tab of [a, b]) await tab.flushOutbox('c1');
});

describe("an Undo in one tab and another tab's send (withdrawFinish across tabs)", () => {
  it("waits for a finish another tab's request carries: answered there, the Undo needs its edit", async () => {
    await a.appendEvents('c1', [finish('f')]);
    const answer = gate();
    b.sync(after(answer, applied));
    const flushing = b.flushOutbox('c1');
    await until(() => b.client.syncListening.mock.calls.length === 1, "B's request");
    // Out, for every tab to read.
    expect(Object.keys(stored()[0].out as object)).toHaveLength(1);

    let done = false;
    const withdrawing = a.withdrawFinish('c1', 3, 'Author/Book').then((w) => {
      done = true;
      return w;
    });
    await sleep(60);
    expect(done).toBe(false);
    expect(storedIds()).toEqual(['f']); // not taken back under the request

    answer.resolve();
    const [, taken] = await Promise.all([flushing, withdrawing]);
    // The server has it: the edit comes after it.
    expect(taken.unsent).toBe(false);
    expect(storedIds()).toEqual([]);
    expect(a.client.syncListening).not.toHaveBeenCalled();
  });

  it("another tab's request got no answer: taken back, and the server may hold it", async () => {
    await a.appendEvents('c1', [finish('f')]);
    const answer = gate();
    b.sync(after(answer, lost));
    const flushing = b.flushOutbox('c1');
    await until(() => b.client.syncListening.mock.calls.length === 1, "B's request");
    const withdrawing = a.withdrawFinish('c1', 3, 'Author/Book');
    await sleep(20);
    answer.resolve();
    const [, taken] = await Promise.all([flushing, withdrawing]);
    expect(taken.unsent).toBe(false);
    expect(storedIds()).toEqual([]);
  });

  it('a request another tab made earlier with no answer is read from the stored outbox', async () => {
    await a.appendEvents('c1', [finish('f')]);
    b.sync(lost);
    await b.flushOutbox('c1');
    expect(stored()[0]).toMatchObject({ maybeReached: true });
    expect(stored()[0].out).toBeUndefined();
    // A never sent it, and holds nothing about it in memory.
    expect((await a.withdrawFinish('c1', 3, 'Author/Book')).unsent).toBe(false);
  });

  it('with the server down by the Undo no edit can be made: undone here, as in one tab', async () => {
    await a.appendEvents('c1', [finish('f')]);
    b.sync(lost);
    await b.flushOutbox('c1');
    mockReachable = false;
    expect((await a.withdrawFinish('c1', 3, 'Author/Book')).unsent).toBe(true);
    expect(storedIds()).toEqual([]);
  });

  it("the server's own refusal in another tab stores nothing: unsent", async () => {
    await a.appendEvents('c1', [finish('f')]);
    b.sync(async () => {
      throw b.refusal(503);
    });
    await b.flushOutbox('c1');
    expect(stored()[0].maybeReached).toBeUndefined();
    expect(stored()[0].out).toBeUndefined();
    expect((await a.withdrawFinish('c1', 3, 'Author/Book')).unsent).toBe(true);
  });

  it('a send another tab starts after the withdrawal leaves the finish out', async () => {
    await a.appendEvents('c1', [listen('a'), finish('f')]);
    // B has read its chunk (both events) and is about to send it.
    const hold = gate();
    mockBeforeSend = hold.promise;
    const flushing = b.flushOutbox('c1');
    await sleep(30);
    mockBeforeSend = null; // only B's send waits on it
    const taken = await a.withdrawFinish('c1', 3, 'Author/Book');
    expect(taken.unsent).toBe(true);
    hold.resolve();
    await flushing;
    // Sent after the Undo's edit, it would have finished the book again.
    expect(b.sent()).toEqual([['a']]);
    expect(storedIds()).toEqual([]);
  });

  it('a tab that went with its request leaves its mark: once it runs out, the edit is sent', async () => {
    const event = finish('f');
    browser.data.set(
      OUTBOX,
      JSON.stringify([{ connectionId: 'c1', event, out: { 'tab-gone': Date.now() + 150 } }]),
    );
    const started = Date.now();
    const taken = await a.withdrawFinish('c1', 3, 'Author/Book');
    // Waited for while the request could still land, then read as "the server may hold it".
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(taken.unsent).toBe(false);
    expect(storedIds()).toEqual([]);
  });

  it('a mark further ahead than any is written for (the clock set back) is not waited for', async () => {
    const event = finish('f');
    browser.data.set(
      OUTBOX,
      JSON.stringify([{ connectionId: 'c1', event, out: { 'tab-gone': Date.now() + 3_600_000 } }]),
    );
    const started = Date.now();
    const taken = await a.withdrawFinish('c1', 3, 'Author/Book');
    // Read as a mark that ran out: the server may hold the finish, so the edit is sent.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(taken.unsent).toBe(false);
    expect(storedIds()).toEqual([]);
  });

  it("an edit that failed puts the finish back, still marked for the other tabs' Undo", async () => {
    await a.appendEvents('c1', [finish('f')]);
    b.sync(lost);
    await b.flushOutbox('c1');
    a.sync(async () => {
      throw a.refusal(503);
    });
    const taken = await a.withdrawFinish('c1', 3, 'Author/Book');
    await taken.restore();
    await a.flushOutbox('c1');
    expect(new Set(a.sent().flat())).toEqual(new Set(['f'])); // sent again
    expect(stored()[0]).toMatchObject({ event: { id: 'f' }, maybeReached: true });
    expect((await b.withdrawFinish('c1', 3, 'Author/Book')).unsent).toBe(false);
  });

  it("a tab takes only its own mark off: another tab's request is still out", async () => {
    const event = finish('f');
    const until_ = Date.now() + 60_000;
    browser.data.set(
      OUTBOX,
      JSON.stringify([{ connectionId: 'c1', event, out: { 'tab-other': until_ } }]),
    );
    const answer = gate();
    a.sync(async () => {
      await answer.promise;
      throw a.refusal(503);
    });
    const flushing = a.flushOutbox('c1');
    await until(() => a.client.syncListening.mock.calls.length === 1, "A's request");
    expect(Object.keys(stored()[0].out as object)).toHaveLength(2);
    answer.resolve();
    await flushing;
    expect(stored()[0].out).toEqual({ 'tab-other': until_ });
    // Left as the test found it, without the mark: the teardown's send waits for nothing.
    browser.data.set(OUTBOX, JSON.stringify([]));
  });
});

describe('a page that is going (sendOnPageHide) and an Undo in another tab', () => {
  it('marks the finish it sends as out for a while, and the Undo waits for its answer', async () => {
    await a.appendEvents('c1', [finish('f')]);
    await b.outboxEvents('c1'); // B has read the outbox
    const answer = gate();
    b.sync(after(answer, applied));
    const before = Date.now();
    b.sendOnPageHide([], 'dev-1');
    expect(b.client.syncListening).toHaveBeenCalledWith(expect.anything(), { keepalive: true });
    const [mark] = Object.values(stored()[0].out as Record<string, number>);
    expect(mark).toBeGreaterThan(before);
    expect(mark).toBeLessThanOrEqual(Date.now() + b.PAGE_HIDE_MARK_MS);

    let done = false;
    const withdrawing = a.withdrawFinish('c1', 3, 'Author/Book').then((w) => {
      done = true;
      return w;
    });
    await sleep(60);
    expect(done).toBe(false);
    answer.resolve();
    expect((await withdrawing).unsent).toBe(false);
    expect(storedIds()).toEqual([]);
  });

  it("marks every connection's finish, one request each", async () => {
    await a.appendEvents('c1', [finish('f1')]);
    await a.appendEvents('c2', [finish('f2')]);
    const answer = gate();
    a.sync(after(answer, applied));
    a.sendOnPageHide([], 'dev-1');
    expect(a.sent()).toEqual([['f1'], ['f2']]);
    expect(stored().map((e) => Object.keys(e.out ?? {}).length)).toEqual([1, 1]);
    answer.resolve();
    await until(() => storedIds().length === 0, 'the answers to be applied');
  });

  it('does not send a finish another tab took back a moment ago', async () => {
    // The other tab's change takes a while to reach this tab's copy.
    browser = fakeBrowser({ delay: 200 });
    a = openTab(browser);
    b = openTab(browser);
    g.localStorage = browser.tab().localStorage;
    await a.appendEvents('c1', [listen('a'), finish('f')]);
    await b.outboxEvents('c1');
    expect((await a.withdrawFinish('c1', 3, 'Author/Book')).unsent).toBe(true);
    b.sendOnPageHide([], 'dev-1');
    expect(b.sent()).toEqual([['a']]);
    await until(() => storedIds().length === 0, 'the answer to be applied');
  });
});

describe('a tab that sweeps the span another tab left sends it (fe#211)', () => {
  it('at once, with no span of its own to close', async () => {
    const left = {
      connectionId: 'c1',
      libraryId: 3,
      path: 'Author/Book',
      from: { pos: 100 },
      to: { pos: 160 },
      duration: 3600,
      speed: 1,
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      endedAt: new Date(Date.now() - 60_000).toISOString(),
      start: 'resume',
      id: 'left',
      owner: 'tab-gone',
      keptAt: Date.now() - a.LIVE_SPAN_MS - 1,
    };
    browser.data.set(OPEN_SPAN, JSON.stringify([left]));
    await a.recoverOpenSpan();
    await until(() => a.client.syncListening.mock.calls.length === 1, 'the swept span to be sent');
    expect(a.sent()).toEqual([['left']]);
    await until(() => storedIds().length === 0, 'its answer');
    expect(JSON.parse(browser.data.get(OPEN_SPAN) ?? 'null')).toBeNull();
  });
});
