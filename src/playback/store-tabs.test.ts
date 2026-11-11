import { Platform } from 'react-native';

import type { Book, ChaptersResponse, ListeningEvent, ListeningSyncRequest } from '@/api/types';
import { tabChannel } from '@/lib/tab-channel';
import { fakeBrowser, type FakeTab, sleep, until } from '@/testing/fake-browser';

import { PLAYING_CHANNEL } from './playing-claim';
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
/** A book's last save: what `progress-sync.ts` keeps in the mirror. */
type MirrorRecord = {
  connectionId: string;
  libraryId: number;
  path: string;
  position: number;
  finished: boolean;
  device_id: string;
  updated_at: string;
};
/** The mirror of the last saves, which the tabs of a browser share (it is in their
 * `localStorage`): the newest record of each book, kept only while `on` (off, a tab reads
 * nothing of another's place, as the tests of the claim alone want it). */
const mockMirror = {
  on: false,
  records: new Map<string, MirrorRecord>(),
  /** Every place saved while `on`, in the order the tabs saved them. */
  saved: [] as number[],
};
const mirrorKey = (connectionId: string, libraryId: number, path: string) =>
  `${connectionId}|${libraryId}|${path}`;

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
  writeMirror: jest.fn(async (save: MirrorRecord) => {
    if (!mockMirror.on) return;
    mockMirror.saved.push(save.position);
    const key = mirrorKey(save.connectionId, save.libraryId, save.path);
    const had = mockMirror.records.get(key);
    if (!had || Date.parse(save.updated_at) >= Date.parse(had.updated_at)) {
      mockMirror.records.set(key, save);
    }
  }),
  ackVersion: jest.fn(async () => {}),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'), // the tabs of a browser are one device
  cachedDeviceId: () => 'dev-1',
  loadInitialProgress: jest.fn(async () => ({ kind: 'empty' })),
  readMirror: jest.fn(async (connectionId: string, libraryId: number, path: string) =>
    mockMirror.on
      ? (mockMirror.records.get(mirrorKey(connectionId, libraryId, path)) ?? null)
      : null,
  ),
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
  /** A play the test holds open (`holdPlay`): asked of the engine, not begun yet. */
  let heldPlay: Promise<void> | null = null;
  /** A pause the test holds open (`holdPause`): asked of the engine, not reported yet. */
  let heldPause: Promise<void> | null = null;
  let pauses = 0;
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
    play: jest.fn(async () => {
      const before = pauses;
      await heldPlay;
      // A pause made while the play was out supersedes it, as in a browser.
      if (pauses === before) push({ state: 'playing' });
    }),
    pause: jest.fn(async () => {
      pauses++;
      if (heldPause) await heldPause;
      push({ state: 'paused' });
    }),
    seekTo: jest.fn(async (position: number) => push({ position })),
    skipToTrack: jest.fn(async (trackIndex: number, position = 0) =>
      push({ trackIndex, position }),
    ),
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
    /** The playing file ends and the next one (`trackIndex`) loads and plays on, as the web
     * engine does it: `loading`, then `playing`, with nothing pressed. */
    advance: (trackIndex: number) => {
      push({ state: 'loading', trackIndex, position: 0 });
      push({ state: 'playing' });
    },
    /** The play buffers a moment and comes back where it is, as a web element does just
     * after it starts: `loading`, then `playing` again, with nothing pressed. */
    stall: () => {
      push({ state: 'loading' });
      push({ state: 'playing' });
    },
    /** The stream dies: the engine reports `error` (and may come back by itself). */
    fail: () => push({ state: 'error' }),
    holdLoad: () => {
      let release: () => void = () => {};
      held = new Promise<void>((r) => (release = r));
      return () => {
        held = null;
        release();
      };
    },
    holdPlay: () => {
      let release: () => void = () => {};
      heldPlay = new Promise<void>((r) => (release = r));
      return () => {
        heldPlay = null;
        release();
      };
    },
    holdPause: () => {
      let release: () => void = () => {};
      heldPause = new Promise<void>((r) => (release = r));
      return () => {
        heldPause = null;
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
/** An hour-long book of one file in `path`, with its chapters. */
function hourLong(id: number, path: string): { book: Book; chapters: ChaptersResponse } {
  const rel = `${path}/1.mp3`;
  return {
    book: { ...book, id, rel_path: path, duration: 3600 },
    chapters: {
      ...chapters,
      path,
      duration: 3600,
      files: [{ rel_path: rel, seq: 0, duration: 3600, format: 'mp3', size: 1 }],
      chapters: [{ ...chapters.chapters[0], file_path: rel, end: 3600 }],
    },
  };
}
/** An hour-long book of three files of 20 minutes in `path`, a chapter each. */
function threeFiles(id: number, path: string): { book: Book; chapters: ChaptersResponse } {
  const rels = [1, 2, 3].map((n) => `${path}/${n}.mp3`);
  return {
    book: { ...book, id, rel_path: path, duration: 3600 },
    chapters: {
      ...chapters,
      path,
      duration: 3600,
      files: rels.map((rel, seq) => ({
        rel_path: rel,
        seq,
        duration: 1200,
        format: 'mp3',
        size: 1,
      })),
      chapters: rels.map((rel, index) => ({
        ...chapters.chapters[0],
        index,
        file_index: index,
        file_path: rel,
        end: 1200,
        book_offset: index * 1200,
      })),
    },
  };
}
const long = hourLong(2, 'B/Long');
const parts = threeFiles(4, 'D/Parts');
const other = hourLong(3, 'C/Other');

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
  let jumpUndo!: typeof import('./jump-undo');
  let types!: typeof import('./types');
  try {
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      store = require('./store') as typeof import('./store');
      outbox = require('./listening-outbox') as typeof import('./listening-outbox');
      jumpUndo = require('./jump-undo') as typeof import('./jump-undo');
      types = require('./types') as typeof import('./types');
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
    start: (at: number, connectionId = 'c1', which = { book, chapters }) =>
      store.usePlayer.getState().playBook(connectionId, 2, which.book, which.chapters, at),
    /** Start the book with no place asked for: its resume, which is 0 for one never played
     * (nothing the listener chose, so another tab's place moves it). */
    open: (which = { book, chapters }) =>
      store.usePlayer.getState().playBook('c1', 2, which.book, which.chapters),
    /** The browser refuses the next play (no gesture in the page yet: a cold deep link):
     * the book it starts stays loaded and paused, and the tab claims nothing. */
    blockPlay: () => engine.svc.play.mockRejectedValueOnce(new types.AutoplayBlockedError()),
    /** Save the place now, as the 15 s save does while it plays. */
    save: async () => {
      store.saveLoadedPlace();
      await sleep(0);
    },
    /** How long after its claim the tab still takes the answer to it (ms). */
    answerBound: store.GAVE_WAY_ANSWER_MS,
    /** The tab is looked at again (`other-tab-notice.ts` calls this on the foreground). */
    lookAt: () => store.showOtherTabsPlace(),
    /** Watch for jumps as the root does; returns the stop (the chip's timer with it). */
    watchJumps: () => {
      const stop = jumpUndo.startJumpUndo();
      return () => {
        stop();
        jumpUndo.clearJumpUndo();
      };
    },
    /** The Undo jump chip's place to go back to, null with no chip. */
    undoFrom: () => jumpUndo.useJumpUndo.getState().jump?.from ?? null,
  };
}

// Real timers and real locks between the tabs: room for a loaded CI machine.
jest.setTimeout(20_000);

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
  mockMirror.on = false;
  mockMirror.records.clear();
  mockMirror.saved = [];
});

/** Every listen the server got as `[from, to, start]`, by where it began. */
const heard = () =>
  listens()
    .map((e) => [e.from_pos, e.to_pos, e.start])
    .sort((x, y) => Number(x[0]) - Number(y[0]) || Number(x[1]) - Number(y[1]));

/** B played the hour-long book (`aPlays`: another one) to 20 s and paused. A started its
 * book there and plays on: its last save was at 35 s, and the listener is at 47 s by now.
 * With the tabs' shared mirror kept. */
async function aheadOfItsSave(a: Tab, b: Tab, aPlays = long) {
  mockMirror.on = true;
  await b.start(5, 'c1', long);
  await sleep(10);
  b.engine.at(20);
  await b.player().pause();
  await a.start(20, 'c1', aPlays);
  await sleep(40); // B hears the claim
  a.engine.at(35);
  await a.save();
  await sleep(10);
  a.engine.at(47);
}

/** The place of every answer (`GaveWay`) a tab of `browser` posts from here on, as another
 * tab of it hears them, in order. */
function answersOn(browser: ReturnType<typeof fakeBrowser>) {
  const places: number[] = [];
  tabChannel<{ kind?: unknown; position: number }>(PLAYING_CHANNEL, browser.tab())?.subscribe(
    (message) => {
      if (message.kind === 'gave-way') places.push(message.position);
    },
  );
  return () => places;
}

/** The listens the server got as `[from, to]`, in the order they were played. */
const chain = () =>
  listens()
    .sort((x, y) => x.started_at.localeCompare(y.started_at) || x.from_pos - y.from_pos)
    .map((e) => [e.from_pos, e.to_pos]);

/** A plays the hour-long book to 30 s; B starts it there (as its resume would) and plays
 * on, so A has given way. With the tabs' shared mirror kept. */
async function playedPast(a: Tab, b: Tab, bPlays = long) {
  mockMirror.on = true;
  await a.start(5, 'c1', long);
  await sleep(10);
  a.engine.at(30);
  await b.start(30, 'c1', bPlays);
  await until(() => a.player().snapshot.state === 'paused', 'A to give way');
  await sleep(10);
}

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
    // It keeps its book, paused where it was.
    expect(a.player().nowPlaying?.path).toBe(folder);
    expect(a.player().snapshot.position).toBe(20);
    // B began at a place the listener chose (an explicit start): A's place moves nothing.
    await sleep(40);
    expect(b.engine.svc.seekTo).not.toHaveBeenCalled();

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
    // B says where it stopped, and A plays on from there, not from the 10 s it had kept.
    await until(() => a.player().snapshot.position === 40, "A to take B's place");

    await sleep(10);
    a.engine.at(45);
    await a.player().pause();
    await until(() => listens().length === 3, 'the three spans on the server');
    expect(heard()).toEqual([
      [5, 10, 'jump'],
      [30, 40, 'jump'],
      [40, 45, 'resume'],
    ]);
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

  it('a tab whose stream died is stopped, so it cannot come back and take the connection', async () => {
    await a.start(5);
    a.engine.fail();
    expect(a.player().snapshot.state).toBe('error');
    await sleep(5); // B's play is asked for later than A's
    await b.start(30);
    // Not playing, so it gives way with nothing (no notice), but its engine is paused: the
    // dead stream can no longer start playing by itself.
    await until(() => a.engine.svc.pause.mock.calls.length === 1, "A's engine to stop");
    await sleep(40);
    expect(a.player().snapshot.state).toBe('error');
    expect(a.gaveWay()).toBe(0);
    expect(b.player().snapshot.state).toBe('playing');
    expect(b.gaveWay()).toBe(0);
    // A Retry there is a play asked for now: it claims the connection back.
    await a.player().retry();
    await until(() => b.player().snapshot.state === 'paused', 'B to give way');
    expect(a.player().snapshot.state).toBe('playing');
  });

  it('a tab whose stream died on another connection is left alone', async () => {
    await a.start(5, 'c1');
    a.engine.fail();
    await b.start(30, 'c2');
    await sleep(40);
    expect(a.engine.svc.pause).not.toHaveBeenCalled();
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

  it('a play just asked for, not yet begun in the engine, gives way and never begins', async () => {
    await a.start(5);
    await a.player().pause();
    const release = a.engine.holdPlay();
    const toggling = a.player().toggle();
    await sleep(5); // B's play is asked for later than A's
    await b.start(30);
    await until(() => a.gaveWay() === 1, 'A to give way');
    release();
    await toggling;
    await sleep(40);
    // The snapshot still read `paused` when the claim landed: the engine is paused all the
    // same, so the play that was out never begins and takes the connection back.
    expect(a.player().snapshot.state).not.toBe('playing');
    expect(b.player().snapshot.state).toBe('playing');
    expect(b.gaveWay()).toBe(0);
  });

  it('a Retry still loading when the other tab plays gives way and never plays', async () => {
    await a.start(5);
    await a.player().pause();
    const release = a.engine.holdLoad();
    const retrying = a.player().retry();
    await until(() => a.engine.svc.load.mock.calls.length === 2, "A's reload");
    await sleep(5); // B's play is asked for later than A's
    await b.start(30);
    await until(() => a.gaveWay() === 1, 'A to give way');
    release();
    await retrying;
    await sleep(40);
    // Played once, by its first start: the reload that gave way never played, so it made no
    // claim of its own and B, the newer play, stands.
    expect(a.engine.svc.play).toHaveBeenCalledTimes(1);
    expect(a.player().snapshot.state).not.toBe('playing');
    expect(b.player().snapshot.state).toBe('playing');
    expect(b.gaveWay()).toBe(0);
  });

  describe('a tab that takes over from one still playing', () => {
    it('plays on from where that tab really was, not from its last save', async () => {
      await aheadOfItsSave(a, b);

      await b.player().toggle();
      await until(() => a.player().snapshot.state === 'paused', 'A to give way');
      await until(() => b.player().snapshot.position === 47, "B to take A's place");
      // From the shared save first (the press is not kept waiting), then A's answer.
      expect(b.engine.svc.seekTo.mock.calls).toEqual([[35], [47]]);
      expect(b.player().snapshot.state).toBe('playing');
      // Saved at once: the shared place is where the listener is.
      const key = mirrorKey('c1', 2, long.book.rel_path);
      await until(() => mockMirror.records.get(key)?.position === 47, 'the place to be saved');

      await sleep(10);
      b.engine.at(55);
      await b.player().pause();
      await until(() => listens().length === 3, 'the three spans on the server');
      // One chain: B's listening begins where A's ended, and nothing of B's is recorded
      // for the 35 s to 47 s it had begun from.
      expect(heard()).toEqual([
        [5, 20, 'jump'],
        [20, 47, 'jump'],
        [47, 55, 'resume'],
      ]);
      expectNoSharedSeconds();
      expect(await b.outbox.storedOpenSpan()).toBeNull();
    });

    it('back and forth three times: one chain, and the saved place never goes back', async () => {
      await aheadOfItsSave(a, b);
      const takeOver = async (to: Tab, from: Tab, at: number) => {
        await to.player().toggle();
        await until(() => from.player().snapshot.state === 'paused', 'the other tab to give way');
        await until(() => to.player().snapshot.position === at, 'its place to be taken');
        expect(to.player().snapshot.state).toBe('playing');
        await sleep(10);
      };
      await takeOver(b, a, 47);
      b.engine.at(60);
      await takeOver(a, b, 60);
      a.engine.at(72);
      await takeOver(b, a, 72);
      b.engine.at(85);
      await b.player().pause();

      await until(() => listens().length === 5, 'the five spans on the server');
      expect(chain()).toEqual([
        [5, 20],
        [20, 47],
        [47, 60],
        [60, 72],
        [72, 85],
      ]);
      expect(listens().filter((e) => e.start === 'moved_back')).toEqual([]);
      expectNoSharedSeconds();
      expect(mockMirror.saved.length).toBeGreaterThan(5);
      expect(mockMirror.saved).toEqual([...mockMirror.saved].sort((x, y) => x - y));
    });

    it('a play from the OS media controls takes it too', async () => {
      await aheadOfItsSave(a, b);
      await b.engine.svc.play(); // no press in the page
      await until(() => a.player().snapshot.state === 'paused', 'A to give way');
      await until(() => b.player().snapshot.position === 47, "B to take A's place");
      expect(b.engine.svc.seekTo.mock.calls).toEqual([[35], [47]]);
      await sleep(10);
      b.engine.at(55);
      await b.player().pause();
      await until(() => listens().length === 3, 'the three spans on the server');
      expect(chain()).toEqual([
        [5, 20],
        [20, 47],
        [47, 55],
      ]);
      expectNoSharedSeconds();
    });

    // A tab claims on every move into `playing`, and a web element buffers a moment after
    // it starts: the tab that takes over has claimed twice by the time the answer to its
    // first claim crosses back (always, over storage events). The answer is to the play.
    it('takes the answer to its first claim after it has claimed again', async () => {
      await aheadOfItsSave(a, b);
      const answers = answersOn(browser);
      const release = browser.hold();
      await b.player().toggle();
      await sleep(2); // the second claim is dated after the first
      b.engine.stall();
      release(); // both claims cross, and then A's answer to the first
      await until(() => a.player().snapshot.state === 'paused', 'A to give way');
      await until(() => b.player().snapshot.position === 47, "B to take A's place");
      expect(b.engine.svc.seekTo.mock.calls).toEqual([[35], [47]]);
      expect(b.player().snapshot.state).toBe('playing');

      await sleep(40);
      // One answer for the play, however often it claimed.
      expect(answers()).toEqual([47]);
      b.engine.at(55);
      await b.player().pause();
      await until(() => listens().length === 3, 'the three spans on the server');
      // Nothing of B's for the 35 s to 47 s it had begun from, before or after its buffer.
      expect(chain()).toEqual([
        [5, 20],
        [20, 47],
        [47, 55],
      ]);
      expectNoSharedSeconds();
    });

    it('a play from the OS media controls that claimed twice takes it too', async () => {
      await aheadOfItsSave(a, b);
      const release = browser.hold();
      await b.engine.svc.play(); // no press in the page
      await sleep(2);
      b.engine.stall();
      release();
      await until(() => a.player().snapshot.state === 'paused', 'A to give way');
      await until(() => b.player().snapshot.position === 47, "B to take A's place");
      expect(b.engine.svc.seekTo.mock.calls).toEqual([[35], [47]]);
      await sleep(10);
      b.engine.at(55);
      await b.player().pause();
      await until(() => listens().length === 3, 'the three spans on the server');
      expect(chain()).toEqual([
        [5, 20],
        [20, 47],
        [47, 55],
      ]);
      expectNoSharedSeconds();
    });

    it('a first play of a book starts where the other tab is, not at 0', async () => {
      await a.start(0, 'c1', long);
      await sleep(10);
      a.engine.at(8);
      const release = browser.hold();
      await b.open(long); // never played: from 0
      expect(b.player().snapshot).toMatchObject({ state: 'playing', position: 0 });
      await sleep(2);
      b.engine.stall();
      release();
      await until(() => a.player().snapshot.state === 'paused', 'A to give way');
      await until(() => b.player().snapshot.position === 8, "B to take A's place");
      expect(b.engine.svc.seekTo.mock.calls).toEqual([[8]]);
      expect(b.player().snapshot.state).toBe('playing');

      await sleep(10);
      b.engine.at(20);
      await b.player().pause();
      await until(() => listens().length === 2, 'both spans on the server');
      // Nothing of B's for the 0 s to 8 s A had played: one chain.
      expect(chain()).toEqual([
        [0, 8],
        [8, 20],
      ]);
      expectNoSharedSeconds();
    });

    it('a tab answers a play once, whatever it reads when the play claims again', async () => {
      await aheadOfItsSave(a, b);
      const answers = answersOn(browser);
      // A's engine is slow to report its pause: A still reads `playing` after it gave way.
      const settle = a.engine.holdPause();
      await b.player().toggle();
      await until(() => b.player().snapshot.position === 47, "B to take A's place");
      // The listener moves A meanwhile (its note of B's play is gone), and B's play claims
      // again: a second answer would send B to A's new place.
      await a.player().seekBook(300);
      b.engine.stall();
      await sleep(40);
      settle();
      await until(() => a.player().snapshot.state === 'paused', "A's pause to land");
      expect(answers()).toEqual([47]);
      expect(b.engine.svc.seekTo.mock.calls).toEqual([[35], [47]]);
      expect(b.player().snapshot).toMatchObject({ state: 'playing', position: 47 });
    });

    it('ignores an answer to a play before its last (a press since)', async () => {
      await aheadOfItsSave(a, b);
      const release = browser.hold();
      await b.player().toggle();
      await sleep(2); // the next play is asked for later
      await b.player().pause();
      await b.player().toggle(); // a new press: another play
      release(); // A answers the first play's claim, which is B's play no more
      await until(() => a.player().snapshot.state === 'paused', 'A to give way');
      await sleep(40);
      expect(b.engine.svc.seekTo.mock.calls).toEqual([[35]]);
      expect(b.player().snapshot).toMatchObject({ state: 'playing', position: 35 });
    });

    it('ignores the place of another book', async () => {
      await aheadOfItsSave(a, b, other);
      await b.player().toggle();
      await until(() => a.player().snapshot.state === 'paused', 'A to give way');
      await sleep(40);
      expect(b.engine.svc.seekTo).not.toHaveBeenCalled();
      expect(b.player().snapshot).toMatchObject({ state: 'playing', position: 20 });
    });

    it('ignores an answer that comes too long after its claim', async () => {
      await aheadOfItsSave(a, b);
      const release = b.engine.holdPlay();
      const toggling = b.player().toggle();
      await until(() => b.engine.svc.play.mock.calls.length === 2, "B's play");
      // B's claim, made longer ago than an answer is taken for.
      const now = Date.now;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now() - b.answerBound - 1000);
      release();
      await toggling;
      clock.mockRestore();
      expect(b.player().snapshot.state).toBe('playing');

      await until(() => a.player().snapshot.state === 'paused', 'A to give way');
      await sleep(40);
      expect(b.engine.svc.seekTo.mock.calls).toEqual([[35]]);
      expect(b.player().snapshot).toMatchObject({ state: 'playing', position: 35 });
    });

    it("the listener's own seek since the claim wins", async () => {
      await aheadOfItsSave(a, b);
      await b.player().toggle();
      await b.player().seekBook(300); // before A's answer has crossed
      await until(() => a.player().snapshot.state === 'paused', 'A to give way');
      await sleep(40);
      expect(b.engine.svc.seekTo.mock.calls).toEqual([[35], [300]]);
      expect(b.player().snapshot).toMatchObject({ state: 'playing', position: 300 });
    });

    it('ignores an answer once yet another tab plays', async () => {
      await aheadOfItsSave(a, b);
      const c = await openTab(browser);
      try {
        // Nothing crosses until C has started too (a moment later: its play is the newer
        // one), so B has given way to C's claim by the time A's answer reaches it.
        const release = browser.hold();
        await b.player().toggle();
        await sleep(2);
        await c.start(500, 'c1', long);
        release();
        await until(() => b.player().snapshot.state === 'paused', 'B to give way');
        await sleep(40);
        expect(b.engine.svc.seekTo.mock.calls).toEqual([[35]]);
      } finally {
        await c.player().stop();
        await c.outbox.storeOpenSpan(null);
        await sleep(0);
        await c.outbox.flushOutbox('c1');
      }
    });
  });

  describe('a tab another tab has played past', () => {
    it('plays again from where the other tab left the same book, in one span from there', async () => {
      await playedPast(a, b);
      b.engine.at(90);
      await b.save(); // B plays on: this is its 15 s save

      await a.player().toggle();
      await until(() => b.player().snapshot.state === 'paused', 'B to give way');
      // Moved before it played: the engine's own seek, then the play.
      expect(a.engine.svc.seekTo).toHaveBeenCalledTimes(1);
      expect(a.engine.svc.seekTo).toHaveBeenCalledWith(90);
      expect(a.engine.svc.seekTo.mock.invocationCallOrder[0]).toBeLessThan(
        a.engine.svc.play.mock.invocationCallOrder[1],
      );
      expect(a.player().snapshot).toMatchObject({ state: 'playing', position: 90 });

      await sleep(10);
      a.engine.at(100);
      // B's answer (90, where A began) comes after A has played on: A is not pulled back.
      await sleep(40);
      expect(a.engine.svc.seekTo).toHaveBeenCalledTimes(1);
      await a.player().pause();
      await until(() => listens().length === 3, 'the three spans on the server');
      // A's second span begins at B's place as a resume: nothing says A moved there, and
      // no span of A's begins at the 30 s it had stopped at (the one from 30 is B's).
      expect(heard()).toEqual([
        [5, 30, 'jump'],
        [30, 90, 'jump'],
        [90, 100, 'resume'],
      ]);
      expectNoSharedSeconds();

      // And back: B is behind A now, and takes A's place before it plays.
      await b.player().toggle();
      await until(() => b.player().snapshot.state === 'playing', 'B to play');
      expect(b.engine.svc.seekTo).toHaveBeenCalledTimes(1);
      expect(b.engine.svc.seekTo).toHaveBeenCalledWith(100);
    });

    it('moves nothing when the other tab played another book', async () => {
      await playedPast(a, b, other);
      b.engine.at(90);
      await b.save();

      await a.player().toggle();
      await until(() => b.player().snapshot.state === 'paused', 'B to give way');
      expect(a.engine.svc.seekTo).not.toHaveBeenCalled();
      expect(a.player().snapshot).toMatchObject({ state: 'playing', position: 30 });
      await sleep(10);
      a.engine.at(40);
      await a.player().pause();
      await until(() => listens().length === 3, 'the three spans on the server');
      expect(heard()).toEqual([
        [5, 30, 'jump'],
        [30, 40, 'resume'],
        [30, 90, 'jump'],
      ]);
    });

    it('moves nothing for a place a moment away', async () => {
      await playedPast(a, b);
      b.engine.at(31.5);
      await b.save();
      await a.player().toggle();
      await until(() => b.player().snapshot.state === 'paused', 'B to give way');
      expect(a.engine.svc.seekTo).not.toHaveBeenCalled();
    });

    it('a move the engine refuses leaves the play that follows saved from where it is', async () => {
      await playedPast(a, b);
      // Far past A's 30 s (more than the save guard's slip tolerance), and B is paused, so
      // no answer of B's moves A there after all.
      b.engine.at(900);
      await b.player().pause();
      await until(() => listens().length === 2, "B's span on the server");
      const key = mirrorKey('c1', 2, long.book.rel_path);
      expect(mockMirror.records.get(key)?.position).toBe(900);
      const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        a.engine.svc.seekTo.mockRejectedValueOnce(new Error('no seek'));
        await a.player().toggle();
        expect(a.player().snapshot).toMatchObject({ state: 'playing', position: 30 });
        await sleep(10);
        a.engine.at(40);
        // The floor is not left at the 900 s the engine never reached: the place saves.
        await a.save();
        expect(mockMirror.records.get(key)?.position).toBe(40);
        await a.player().pause();
        await until(() => listens().length === 3, 'the three spans on the server');
        expect(heard()).toEqual([
          [5, 30, 'jump'],
          [30, 40, 'resume'],
          [30, 900, 'jump'],
        ]);
      } finally {
        warned.mockRestore();
      }
    });

    it('takes an earlier place too: the other tab is the latest listening', async () => {
      await playedPast(a, b);
      await b.player().seekBook(12); // the listener went back in B, which plays on
      await sleep(10);
      b.engine.at(15);
      await b.save();
      await a.player().toggle();
      await until(() => b.player().snapshot.state === 'paused', 'B to give way');
      expect(a.engine.svc.seekTo).toHaveBeenCalledWith(15);
      expect(a.player().snapshot).toMatchObject({ state: 'playing', position: 15 });
      await sleep(10);
      a.engine.at(20);
      await a.player().pause();
      await until(() => listens().length === 4, 'the four spans on the server');
      // The only move back anyone made is B's own.
      expect(heard()).toEqual([
        [5, 30, 'jump'],
        [12, 15, 'moved_back'],
        [15, 20, 'resume'],
        [30, 30, 'jump'],
      ]);
    });

    it('a play from the OS media controls moves there as it plays, its span from there', async () => {
      await playedPast(a, b);
      b.engine.at(90);
      await b.save();

      await a.engine.svc.play(); // no press in the page: the engine plays from 30
      await until(() => b.player().snapshot.state === 'paused', 'B to give way');
      await until(() => a.engine.svc.seekTo.mock.calls.length === 1, 'A to move');
      expect(a.engine.svc.seekTo).toHaveBeenCalledWith(90);
      await sleep(10);
      a.engine.at(100);
      await a.player().pause();
      await until(() => listens().length === 3, 'the three spans on the server');
      expect(heard()).toEqual([
        [5, 30, 'jump'],
        [30, 90, 'jump'],
        [90, 100, 'resume'],
      ]);
      expectNoSharedSeconds();
    });

    it('a tab still moving to the shared place gives way with no place of its own', async () => {
      const c = await openTab(browser);
      try {
        // C has the book too, paused at 30 s before the others play it.
        mockMirror.on = true;
        await c.start(30, 'c1', long);
        await c.player().pause();
        await playedPast(a, b);
        b.engine.at(50);
        await b.player().pause();
        const key = mirrorKey('c1', 2, long.book.rel_path);
        await until(() => mockMirror.records.get(key)?.position === 50, "B's place to be saved");

        // A plays by itself from its 30 s, and its move to B's 50 s is still out.
        a.engine.svc.seekTo.mockImplementationOnce(() => new Promise<void>(() => {}));
        await a.engine.svc.play();
        await until(() => a.engine.svc.seekTo.mock.calls.length === 1, 'A to move');
        await sleep(40); // C hears A's claim

        // C plays from the shared 50 s. A gives way, and the 30 s its engine is still at is
        // not where the listening was: C is told nothing, and stays.
        await c.player().toggle();
        await until(() => a.player().snapshot.state === 'paused', 'A to give way');
        await sleep(40);
        expect(c.engine.svc.seekTo.mock.calls).toEqual([[50]]);
        expect(c.player().snapshot).toMatchObject({ state: 'playing', position: 50 });
      } finally {
        await c.player().stop();
        await c.outbox.storeOpenSpan(null);
        await sleep(0);
        await c.outbox.flushOutbox('c1');
      }
    });

    it('a move still out when another book starts holds none of that book', async () => {
      await playedPast(a, b);
      b.engine.at(90);
      await b.save();

      // The engine never answers the seek (a route that went away mid-move).
      a.engine.svc.seekTo.mockImplementationOnce(() => new Promise<void>(() => {}));
      await a.engine.svc.play();
      await until(() => a.engine.svc.seekTo.mock.calls.length === 1, 'A to move');
      await a.start(100, 'c1', other);
      await sleep(10);
      a.engine.at(110);
      await a.save();
      const key = mirrorKey('c1', 2, other.book.rel_path);
      expect(mockMirror.records.get(key)?.position).toBe(110);
      await a.player().pause();
      await until(
        () => listens().some((e) => e.path === other.book.rel_path),
        "the other book's span on the server",
      );
      expect(
        listens()
          .filter((e) => e.path === other.book.rel_path)
          .map((e) => [e.from_pos, e.to_pos, e.start]),
      ).toEqual([[100, 110, 'jump']]);
    });

    it('a tab paused by hand before the other tab played follows it too', async () => {
      mockMirror.on = true;
      await a.start(5, 'c1', long);
      await sleep(10);
      a.engine.at(30);
      await a.player().pause();
      await b.start(30, 'c1', long);
      await sleep(40); // A hears the claim
      b.engine.at(90);
      await b.save();
      expect(a.gaveWay()).toBe(0);

      await a.player().toggle();
      await until(() => b.player().snapshot.state === 'paused', 'B to give way');
      expect(a.engine.svc.seekTo).toHaveBeenCalledWith(90);
      expect(a.player().snapshot).toMatchObject({ state: 'playing', position: 90 });
    });

    it("saves nothing of its own place over the other tab's, until it plays", async () => {
      await playedPast(a, b);
      const key = mirrorKey('c1', 2, long.book.rel_path);
      // The place it gave way at was saved.
      expect(mockMirror.records.get(key)?.position).toBe(30);
      b.engine.at(90);
      await b.save();
      expect(mockMirror.records.get(key)?.position).toBe(90);
      // A save of the paused tab's (a speed change; the place reconcile's on the foreground).
      await a.save();
      await a.player().setRate(1.25);
      await sleep(0);
      expect(mockMirror.records.get(key)?.position).toBe(90);

      await a.player().toggle();
      await until(() => b.player().snapshot.state === 'paused', 'B to give way');
      a.engine.at(95);
      await a.save();
      expect(mockMirror.records.get(key)?.position).toBe(95);
    });

    it("the listener's own move in the paused tab stands", async () => {
      await playedPast(a, b);
      b.engine.at(90);
      await b.save();
      await a.player().seekBook(300);
      b.engine.at(100);
      await b.save();

      await a.player().toggle();
      await until(() => b.player().snapshot.state === 'paused', 'B to give way');
      expect(a.engine.svc.seekTo.mock.calls).toEqual([[300]]);
      expect(a.player().snapshot).toMatchObject({ state: 'playing', position: 300 });
    });

    /** A plays the three-file book to 30 s; B starts it there and plays on into its second
     * file, so A has given way. With the tabs' shared mirror kept. */
    async function playedIntoNextFile() {
      mockMirror.on = true;
      await a.start(5, 'c1', parts);
      await sleep(10);
      a.engine.at(30);
      await b.start(30, 'c1', parts);
      await until(() => a.player().snapshot.state === 'paused', 'A to give way');
      await sleep(10);
      b.engine.advance(1);
      await sleep(40); // A hears B claim again
    }

    it("the listener's own move stands while the other tab plays on into its next files", async () => {
      await playedIntoNextFile();
      await a.player().seekBook(600);
      // B plays on into its third file: the same play, which claims again.
      b.engine.at(100);
      await b.save();
      b.engine.advance(2);
      await sleep(40);
      b.engine.at(50);
      await b.save();
      const key = mirrorKey('c1', 2, parts.book.rel_path);
      expect(mockMirror.records.get(key)?.position).toBe(2450);

      await a.player().toggle();
      await until(() => b.player().snapshot.state === 'paused', 'B to give way');
      await sleep(40); // B's answer, which moves nothing either
      expect(a.engine.svc.seekTo.mock.calls).toEqual([[600]]);
      expect(a.engine.svc.skipToTrack).not.toHaveBeenCalled();
      expect(a.player().snapshot).toMatchObject({ state: 'playing', trackIndex: 0, position: 600 });
    });

    it('with no move of its own it follows the other tab across its files', async () => {
      await playedIntoNextFile();
      b.engine.at(100);
      await b.save();
      b.engine.advance(2);
      await sleep(40);
      b.engine.at(50);
      await b.player().pause();
      const key = mirrorKey('c1', 2, parts.book.rel_path);
      await until(() => mockMirror.records.get(key)?.position === 2450, "B's place to be saved");

      await a.player().toggle();
      expect(a.engine.svc.skipToTrack.mock.calls).toEqual([[2, 50]]);
      expect(a.player().snapshot).toMatchObject({ state: 'playing', trackIndex: 2, position: 50 });
    });

    it('a new play in the other tab is noted again, over a move made here since', async () => {
      await playedIntoNextFile();
      await a.player().seekBook(600);
      b.engine.at(100);
      await b.player().pause();
      await b.player().toggle(); // pressed again: a new play, not the one going on
      await sleep(40);
      b.engine.at(200);
      await b.player().pause();
      const key = mirrorKey('c1', 2, parts.book.rel_path);
      await until(() => mockMirror.records.get(key)?.position === 1400, "B's place to be saved");

      await a.player().toggle();
      expect(a.engine.svc.skipToTrack.mock.calls).toEqual([[1, 200]]);
      expect(a.player().snapshot).toMatchObject({ state: 'playing', trackIndex: 1, position: 200 });
    });

    it('a book loaded after the other tab began playing still follows it', async () => {
      await playedIntoNextFile();
      // A starts the book again where the tabs' shared place is, and the browser refuses
      // the play: loaded, paused, and nothing claimed.
      b.engine.at(100);
      await b.save();
      a.blockPlay();
      await a.start(1300, 'c1', parts);
      expect(a.player().snapshot.state).toBe('paused');
      expect(b.player().snapshot.state).toBe('playing');

      b.engine.advance(2);
      await sleep(40); // the play A noted before this load, going on: noted again
      b.engine.at(50);
      await b.player().pause();
      const key = mirrorKey('c1', 2, parts.book.rel_path);
      await until(() => mockMirror.records.get(key)?.position === 2450, "B's place to be saved");

      await a.player().toggle();
      expect(a.engine.svc.skipToTrack.mock.calls).toEqual([[2, 50]]);
      expect(a.player().snapshot).toMatchObject({ state: 'playing', trackIndex: 2, position: 50 });
    });

    it('a book the other tab finished starts again, unfinished first', async () => {
      await playedPast(a, b);
      // B finished the book and plays no more: the record its finish writes.
      await b.player().pause();
      mockMirror.records.set(mirrorKey('c1', 2, long.book.rel_path), {
        connectionId: 'c1',
        libraryId: 2,
        path: long.book.rel_path,
        position: 3600,
        finished: true,
        device_id: 'dev-1',
        updated_at: new Date().toISOString(),
      });

      // Looked at while paused, it stays where it is.
      a.lookAt();
      await sleep(10);
      expect(a.engine.svc.seekTo).not.toHaveBeenCalled();

      await a.player().toggle();
      expect(a.player().snapshot.state).toBe('playing');
      expect(a.engine.svc.seekTo).toHaveBeenCalledWith(0);
      await sleep(10);
      a.engine.at(8);
      await a.player().pause();
      await until(() => listens().some((e) => e.start === 'restart'), "A's span on the server");
      expect(listens().find((e) => e.start === 'restart')).toMatchObject({
        from_pos: 0,
        to_pos: 8,
      });
      expect(mockServer.events.filter((e) => e.kind === 'unfinish')).toHaveLength(1);
    });

    it('looked at again while paused, it shows the place the other tab played to', async () => {
      await playedPast(a, b);
      b.engine.at(90);
      await b.save();

      a.lookAt();
      await until(() => a.engine.svc.seekTo.mock.calls.length === 1, 'A to show the place');
      expect(a.player().snapshot).toMatchObject({ state: 'paused', position: 90 });
      await sleep(40);
      // Shown, not played: B plays on, and A said nothing to the server.
      expect(b.player().snapshot.state).toBe('playing');
      expect(a.engine.svc.play).toHaveBeenCalledTimes(1);

      // The play that follows looks again: B has played on since.
      b.engine.at(120);
      await b.save();
      await a.player().toggle();
      await until(() => b.player().snapshot.state === 'paused', 'B to give way');
      expect(a.engine.svc.seekTo).toHaveBeenLastCalledWith(120);
      await sleep(10);
      a.engine.at(130);
      await a.player().pause();
      await until(() => listens().length === 3, 'the three spans on the server');
      expect(heard().map(([from, , start]) => [from, start])).toEqual([
        [5, 'jump'],
        [30, 'jump'],
        [120, 'resume'],
      ]);
    });

    it('a Retry reloads where the other tab left the book', async () => {
      mockMirror.on = true;
      await a.start(5, 'c1', long);
      a.engine.at(30);
      a.engine.fail();
      await sleep(5);
      await b.start(30, 'c1', long);
      await until(() => a.engine.svc.pause.mock.calls.length === 1, "A's engine to stop");
      b.engine.at(90);
      await b.save();

      await a.player().retry();
      await until(() => b.player().snapshot.state === 'paused', 'B to give way');
      expect(a.engine.svc.load).toHaveBeenLastCalledWith(
        expect.anything(),
        0,
        90,
        expect.anything(),
        expect.anything(),
      );
      expect(a.player().snapshot.state).toBe('playing');
    });
  });
});

describe("the Undo jump chip after a tab takes another tab's place", () => {
  it('offers the way back to where this tab had stopped', async () => {
    const browser = fakeBrowser({ delay: 12 });
    const a = await openTab(browser);
    const b = await openTab(browser);
    const stopWatching = a.watchJumps();
    try {
      await playedPast(a, b);
      // A book just loaded only settles for its first seconds (`SETTLE_MS`).
      await sleep(3_100);
      b.engine.at(150);
      await b.save();
      expect(a.undoFrom()).toBeNull();

      await a.player().toggle();
      await until(() => b.player().snapshot.state === 'paused', 'B to give way');
      expect(a.player().snapshot).toMatchObject({ state: 'playing', position: 150 });
      expect(a.undoFrom()).toBe(30);
    } finally {
      stopWatching();
      for (const tab of [a, b]) {
        await tab.player().stop();
        await tab.outbox.storeOpenSpan(null);
        await sleep(0);
        await tab.outbox.flushOutbox('c1');
      }
      await until(async () => (await a.outbox.outboxEvents()).length === 0, 'the outbox to empty');
    }
  });
});
