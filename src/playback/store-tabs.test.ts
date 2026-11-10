import { Platform } from 'react-native';

import type { Book, ChaptersResponse, ListeningEvent, ListeningSyncRequest } from '@/api/types';
import { fakeBrowser, type FakeTab } from '@/testing/fake-browser';

import type { PlaybackService, PlaybackSnapshot } from './types';

// One tab plays at a time (fe#123), with two tabs that are each the real store and the real
// listening outbox: two module instances (`jest.isolateModules`) over one browser's shared
// storage and channel (`fakeBrowser`), each with an engine of its own and one server
// between them. What the server is sent is what the two tabs recorded.

/** The tab whose modules are being loaded: each mock factory below runs once per tab. */
let mockTab: FakeTab;
/** The engine the tab being loaded gets. */
let mockEngine: Engine;
/** Every `listen` and `finish` the tabs sent, in the order the server got them. */
const mockServer: { events: ListeningEvent[] } = { events: [] };

jest.mock('@/lib/storage', () => {
  // The web's storage is the browser's `localStorage`: each tab's copy reads and writes its
  // own tab's, so a write tells the OTHER tabs.
  const { tabStorage } = jest.requireActual('@/testing/fake-browser');
  return { ...jest.requireActual('@/lib/storage'), ...tabStorage(mockTab.localStorage) };
});
jest.mock('./service', () => {
  const engine = mockEngine;
  return { createPlaybackService: () => engine.svc };
});
jest.mock('./progress-sync', () => ({
  saveProgress: jest.fn(async () => {}),
  writeMirror: jest.fn(async () => {}),
  ackVersion: jest.fn(async () => {}),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'), // the tabs of a browser are one device
  cachedDeviceId: () => 'dev-1',
  loadInitialProgress: jest.fn(async () => ({ kind: 'empty' })),
  readMirror: jest.fn(async () => null),
  guardSettled: () => false,
  noteClockSkew: jest.fn(),
  pendingSaves: jest.fn(async () => ({ events: 0, listens: 0 })),
}));
jest.mock('./time-saved', () => ({ noteSilenceSaved: jest.fn(), flushTimeSaved: jest.fn() }));
jest.mock('@/api/provider', () => ({
  queryClient: {
    invalidateQueries: jest.fn(async () => {}),
    setQueryData: jest.fn(),
    setQueryDefaults: jest.fn(),
    fetchQuery: jest.fn(async () => ({})),
    getQueryData: jest.fn(() => undefined),
    cancelQueries: jest.fn(async () => {}),
  },
}));
// Every server reachable (the real module would start its probe timers on a failure).
const mockNoteFailure = jest.fn();
jest.mock('@/api/reachability', () => ({
  isReachable: () => true,
  noteSuccess: jest.fn(),
  noteFailure: (...a: unknown[]) => mockNoteFailure(...a),
}));
jest.mock('@/lib/network', () => ({ canAutoDownload: jest.fn(() => Promise.resolve(false)) }));
jest.mock('@/api/connection-clients', () => ({
  resolveClient: () => ({
    coverUrl: (lib: number, path: string) => `cover:${lib}:${path}`,
    streamUrl: (lib: number, path: string) => `stream:${lib}:${path}`,
    authHeaders: () => ({ Authorization: 'Bearer x' }),
    addHistory: jest.fn(async () => {}),
    syncListening: async (body: ListeningSyncRequest) => {
      for (const e of body.events) {
        if (!mockServer.events.some((had) => had.id === e.id)) mockServer.events.push(e);
      }
      return {
        server_time: new Date().toISOString(),
        results: body.events.map((e) => ({ id: e.id, status: 'applied' })),
        progress: [],
      };
    },
  }),
  sessionReady: jest.fn(() => true),
}));

const INITIAL: PlaybackSnapshot = {
  state: 'idle',
  trackIndex: 0,
  position: 0,
  duration: 0,
  rate: 1,
};

/** A tab's engine: it plays and pauses when told, and the test moves its place. */
type Engine = ReturnType<typeof makeEngine>;
function makeEngine() {
  let listener: (s: PlaybackSnapshot) => void = () => {};
  let snapshot = { ...INITIAL };
  const push = (next: Partial<PlaybackSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    listener(snapshot);
  };
  /** A load the test holds open (`holdLoad`), released by calling it. */
  let held: Promise<void> | null = null;
  const svc = {
    onRemoteSeek: jest.fn(),
    onRemoteMove: jest.fn(),
    onRateChange: jest.fn(),
    onSilenceSaved: jest.fn(),
    setup: jest.fn(async () => {}),
    configure: jest.fn(async () => {}),
    load: jest.fn(async (_tracks: unknown, trackIndex: number, position: number) => {
      push({ state: 'loading', trackIndex, position, duration: 50 });
      await held;
    }),
    play: jest.fn(async () => push({ state: 'playing' })),
    pause: jest.fn(async () => push({ state: 'paused' })),
    seekTo: jest.fn(async () => {}),
    skipToTrack: jest.fn(async () => {}),
    setRate: jest.fn(async () => {}),
    setVolume: jest.fn(async () => {}),
    reset: jest.fn(async () => push({ ...INITIAL })),
    getSnapshot: jest.fn(() => snapshot),
    subscribe: jest.fn((l: (s: PlaybackSnapshot) => void) => {
      listener = l;
      return () => {};
    }),
  };
  return {
    svc: svc as typeof svc & PlaybackService,
    /** The engine plays on to `position` (seconds into the file). */
    at: (position: number) => push({ position }),
    holdLoad: () => {
      let release: () => void = () => {};
      held = new Promise<void>((r) => (release = r));
      return () => {
        held = null;
        release();
      };
    },
  };
}

const folder = 'A/Folder';
const file = 'A/Folder/1.mp3';
const chapters: ChaptersResponse = {
  library_id: 2,
  path: folder,
  duration: 50,
  is_folder: true,
  files: [{ rel_path: file, seq: 0, duration: 50, format: 'mp3', size: 1 }],
  chapters: [
    { index: 0, title: 'One', file_index: 0, file_path: file, start: 0, end: 50, book_offset: 0 },
  ],
};
const book: Book = {
  id: 1,
  library_id: 2,
  rel_path: folder,
  is_folder: true,
  title: 'A Book',
  author: 'Author',
  series: '',
  series_index: 0,
  narrator: '',
  duration: 50,
  format: 'mp3',
  size: 0,
};

type Tab = Awaited<ReturnType<typeof openTab>>;

/** Open a tab of `browser`: its own copies of the store and the outbox, the service made
 * (so it listens for the other tabs' claims) while the tab's globals are the window's. */
async function openTab(browser: ReturnType<typeof fakeBrowser>, { lateNotice = false } = {}) {
  const tab = browser.tab();
  const engine = makeEngine();
  mockTab = tab;
  mockEngine = engine;
  const g = globalThis as Record<string, unknown>;
  const before = {
    BroadcastChannel: g.BroadcastChannel,
    localStorage: g.localStorage,
    addEventListener: g.addEventListener,
    removeEventListener: g.removeEventListener,
  };
  Object.assign(g, {
    BroadcastChannel: tab.BroadcastChannel,
    localStorage: tab.localStorage,
    addEventListener: tab.addEventListener,
    removeEventListener: tab.removeEventListener,
  });
  let store!: typeof import('./store');
  let outbox!: typeof import('./listening-outbox');
  try {
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      store = require('./store') as typeof import('./store');
      outbox = require('./listening-outbox') as typeof import('./listening-outbox');
      /* eslint-enable @typescript-eslint/no-require-imports */
    });
    await store.initializePlayback();
  } finally {
    Object.assign(g, before);
  }
  let gaveWay = 0;
  const listen = () => store.onGaveWayToTab(() => gaveWay++);
  if (!lateNotice) listen();
  return {
    engine,
    outbox,
    player: () => store.usePlayer.getState(),
    /** How often the tab told its listener it gave way (the notice). */
    gaveWay: () => gaveWay,
    /** Register the notice's listener (a tab opened with `lateNotice`). */
    listen,
    /** Start the book on `connectionId` at `at` seconds (the engine plays from there). */
    start: (at: number, connectionId = 'c1') =>
      store.usePlayer.getState().playBook(connectionId, 2, book, chapters, at),
  };
}

// Real timers and real locks between the tabs: room for a loaded CI machine.
jest.setTimeout(20_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `done()` (the tabs talk in later turns, the outbox through its locks). */
async function until(done: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 1000; i++) {
    if (await done()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const listens = () =>
  mockServer.events.filter((e): e is Extract<ListeningEvent, { kind: 'listen' }> => {
    return e.kind === 'listen';
  });

/** Every listen the server got, by when it began: none begins before the last one ended. */
function expectNoSharedSeconds() {
  const spans = listens().sort((x, y) => x.started_at.localeCompare(y.started_at));
  for (let i = 1; i < spans.length; i++) {
    expect(Date.parse(spans[i].started_at)).toBeGreaterThanOrEqual(
      Date.parse(spans[i - 1].ended_at),
    );
  }
}

// The web, for every tab: React Native reads `Platform` through a lazy getter, which a
// module loaded in `isolateModules` resolves in this file's own registry once that returns.
const os = Platform.OS;
beforeAll(() => {
  Platform.OS = 'web';
});
afterAll(() => {
  Platform.OS = os;
});

beforeEach(() => {
  mockServer.events = [];
  mockNoteFailure.mockClear();
});

const nav = globalThis.navigator as { locks?: unknown };

describe.each([
  ['BroadcastChannel and Web Locks (https, localhost)', true],
  ['storage events and the localStorage lease (no BroadcastChannel, plain http)', false],
])('two tabs of one connection over %s', (_name, modern) => {
  let browser: ReturnType<typeof fakeBrowser>;
  let a: Tab;
  let b: Tab;
  const g = globalThis as Record<string, unknown>;
  const hadStorage = g.localStorage;

  beforeEach(async () => {
    // A claim takes a moment to cross to the other tab, which plays on until it lands.
    browser = fakeBrowser({ broadcast: modern, delay: 12 });
    // Plain http has no Web Locks: the outbox's lock is its `localStorage` lease, in the
    // storage every tab shares.
    if (!modern) {
      Object.defineProperty(nav, 'locks', { configurable: true, value: undefined });
      g.localStorage = browser.tab().localStorage;
    }
    a = await openTab(browser);
    b = await openTab(browser);
  });
  afterEach(async () => {
    await a.player().stop();
    await b.player().stop();
    // Every close and send over before the file's modules go, so nothing runs on after the
    // test: a span write queues behind the closes still waiting their turn, and each close
    // starts its send as it ends.
    for (const tab of [a, b]) {
      await tab.outbox.storeOpenSpan(null);
      await sleep(0);
      await Promise.all(['c1', 'c2'].map((cid) => tab.outbox.flushOutbox(cid)));
    }
    await until(async () => (await a.outbox.outboxEvents()).length === 0, 'the outbox to empty');
    expect(mockNoteFailure).not.toHaveBeenCalled();
    if (!modern) {
      delete nav.locks;
      g.localStorage = hadStorage;
    }
  });

  it('play in B pauses A, whose span is one event; no second is recorded twice', async () => {
    await a.start(5);
    await sleep(20);
    a.engine.at(20);
    expect(a.player().snapshot.state).toBe('playing');

    await b.start(30);
    await until(() => a.player().snapshot.state === 'paused', 'A to give way');
    expect(b.player().snapshot.state).toBe('playing');
    expect(a.engine.svc.pause).toHaveBeenCalledTimes(1);
    expect(a.gaveWay()).toBe(1);
    expect(b.gaveWay()).toBe(0);
    // It keeps its book and its place.
    expect(a.player().nowPlaying?.path).toBe(folder);
    expect(a.player().snapshot.position).toBe(20);

    await sleep(20);
    b.engine.at(45);
    await b.player().pause();
    await until(() => listens().length === 2, 'both spans on the server');
    expect(listens().map((e) => [e.from_pos, e.to_pos])).toEqual(
      expect.arrayContaining([
        [5, 20],
        [30, 45],
      ]),
    );
    expectNoSharedSeconds();
    // Nothing left behind: no span still open, nothing waiting.
    await until(async () => (await a.outbox.outboxEvents()).length === 0, 'the outbox to empty');
    expect(await a.outbox.storedOpenSpan()).toBeNull();
    expect(await b.outbox.storedOpenSpan()).toBeNull();
  });

  it('play again in A claims it back: B pauses, and still nothing is recorded twice', async () => {
    await a.start(5);
    await sleep(10);
    a.engine.at(10);
    await b.start(30);
    await until(() => a.player().snapshot.state === 'paused', 'A to give way');
    await sleep(10);
    b.engine.at(40);

    await a.player().toggle();
    await until(() => b.player().snapshot.state === 'paused', 'B to give way');
    expect(a.player().snapshot.state).toBe('playing');
    expect([a.gaveWay(), b.gaveWay()]).toEqual([1, 1]);
    expect(b.engine.svc.pause).toHaveBeenCalledTimes(1);

    await sleep(10);
    a.engine.at(15);
    await a.player().pause();
    await until(() => listens().length === 3, 'the three spans on the server');
    expect(listens().map((e) => [e.from_pos, e.to_pos])).toEqual(
      expect.arrayContaining([
        [5, 10],
        [30, 40],
        [10, 15],
      ]),
    );
    expectNoSharedSeconds();
  });

  it('a tab that is not playing does nothing', async () => {
    await a.start(5);
    await a.player().pause();
    await until(() => listens().length === 1, "A's span on the server");
    await b.start(30);
    await sleep(40);
    expect(b.player().snapshot.state).toBe('playing');
    expect(a.engine.svc.pause).toHaveBeenCalledTimes(1); // its own pause only
    expect(a.gaveWay()).toBe(0);
  });

  it('another connection plays on beside it', async () => {
    await a.start(5, 'c1');
    await b.start(30, 'c2');
    await sleep(40);
    expect(a.player().snapshot.state).toBe('playing');
    expect(b.player().snapshot.state).toBe('playing');
    expect([a.gaveWay(), b.gaveWay()]).toEqual([0, 0]);
  });

  it('a play from the OS media controls (the engine starts by itself) claims it back too', async () => {
    await a.start(5);
    await sleep(5); // B's play is asked for later than A's
    await b.start(30);
    await until(() => a.player().snapshot.state === 'paused', 'A to give way');
    await sleep(5);
    await a.engine.svc.play(); // no press in the page: the store only sees the engine play
    await until(() => b.player().snapshot.state === 'paused', 'B to give way');
    expect(a.player().snapshot.state).toBe('playing');
    expect([a.gaveWay(), b.gaveWay()]).toEqual([1, 1]);
  });

  it('a tab whose services start late is still told it gave way', async () => {
    // The web starts the root's services (the notice among them) after the first paint.
    const c = await openTab(browser, { lateNotice: true });
    await c.start(5);
    await sleep(5); // B's play is asked for later than C's
    await b.start(30);
    await until(() => c.player().snapshot.state === 'paused', 'C to give way');
    expect(c.gaveWay()).toBe(0);
    const stop = c.listen();
    expect(c.gaveWay()).toBe(1);
    stop();
    // Told once: a listener that registers later hears nothing old.
    c.listen();
    expect(c.gaveWay()).toBe(1);
    await c.player().stop();
    await c.outbox.storeOpenSpan(null);
    await sleep(0);
    await c.outbox.flushOutbox('c1');
  });

  it('a start still loading when the other tab plays gives way and never plays', async () => {
    const release = a.engine.holdLoad();
    const starting = a.start(5);
    await until(() => a.engine.svc.load.mock.calls.length === 1, "A's load");
    await sleep(5); // B's play is asked for later than A's
    await b.start(30);
    await until(() => a.gaveWay() === 1, 'A to give way');
    release();
    await starting;
    await sleep(20);
    expect(a.engine.svc.play).not.toHaveBeenCalled();
    expect(a.player().snapshot.state).not.toBe('playing');
    expect(b.player().snapshot.state).toBe('playing');
    expect(b.gaveWay()).toBe(0);
    // Loaded, though: a press on play starts it, and B gives way.
    await a.player().toggle();
    await until(() => b.player().snapshot.state === 'paused', 'B to give way');
    expect(a.player().snapshot.state).toBe('playing');
  });
});
