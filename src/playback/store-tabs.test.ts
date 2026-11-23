import { Platform } from 'react-native';

import type { Book, ChaptersResponse, ListeningEvent, ListeningSyncRequest } from '@/api/types';
import { tabChannel } from '@/lib/tab-channel';
import { fakeBrowser, type FakeTab, sleep, until } from '@/testing/fake-browser';

import { PLAYING_CHANNEL } from './playing-claim';
import type { PlaybackService, PlaybackSnapshot, PlaybackTrack } from './types';

// One tab plays at a time (fe#123), with two tabs that are each the real store and the real
// listening outbox: two module instances (`jest.isolateModules`) over one browser's shared
// storage and channel (`fakeBrowser`), each with an engine of its own and one server
// between them. What the server is sent is what the two tabs recorded.

/** The tab whose modules are being loaded: each mock factory below runs once per tab. */
let mockTab: FakeTab;
/** The engine the tab being loaded gets. */
let mockEngine: Engine;
/** Every `listen` and `finish` the tabs sent, in the order the server got them, and every
 * span a tab posted to `POST /history` (a server that takes no listening events). */
const mockServer: { events: ListeningEvent[]; history: { from_pos: number; to_pos: number }[] } = {
  events: [],
  history: [],
};
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
/** How far the server's clock is ahead of the browser's (ms), for its rows in the mirror. */
let mockSkewMs = 0;
const mockBookSource = jest.fn<Promise<{ book: Book; chapters: ChaptersResponse }>, []>();
jest.mock('./book-source', () => ({
  ...jest.requireActual('./book-source'),
  bookSourceOf: () => mockBookSource(),
}));
const mockLoadProgress = jest.fn(async () => ({ kind: 'empty' }));
const mirrorKey = (connectionId: string, libraryId: number, path: string) =>
  `${connectionId}|${libraryId}|${path}`;

jest.mock('@/lib/storage', () => {
  // The web's storage is the browser's `localStorage`: each tab's copy reads and writes its
  // own tab's, so a write tells the OTHER tabs.
  // None for this file's own imports (`playing-claim` reads the connection aliases' module),
  // loaded before any tab: only a tab's modules read storage.
  const { tabStorage } = jest.requireActual('@/testing/fake-browser');
  return {
    ...jest.requireActual('@/lib/storage'),
    ...(mockTab ? tabStorage(mockTab.localStorage) : {}),
  };
});
jest.mock('./service', () => {
  const engine = mockEngine;
  return { createPlaybackService: () => engine.svc };
});
/** Keep `save` in the mirror while it is `on`: the newest record of its book. */
async function mockWriteMirror(save: MirrorRecord) {
  if (!mockMirror.on) return;
  mockMirror.saved.push(save.position);
  const key = mirrorKey(save.connectionId, save.libraryId, save.path);
  const had = mockMirror.records.get(key);
  if (!had || Date.parse(save.updated_at) >= Date.parse(had.updated_at)) {
    mockMirror.records.set(key, save);
  }
}
jest.mock('./progress-sync', () => ({
  // The PUT path (a server that takes no listening events) keeps the mirror too.
  saveProgress: jest.fn(async (_api: unknown, save: MirrorRecord) => mockWriteMirror(save)),
  writeMirror: jest.fn((save: MirrorRecord) => mockWriteMirror(save)),
  ackVersion: jest.fn(async () => {}),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'), // the tabs of a browser are one device
  cachedDeviceId: () => 'dev-1',
  loadInitialProgress: () => mockLoadProgress(),
  readMirror: jest.fn(async (connectionId: string, libraryId: number, path: string) =>
    mockMirror.on
      ? (mockMirror.records.get(mirrorKey(connectionId, libraryId, path)) ?? null)
      : null,
  ),
  guardSettled: () => false,
  // By this device's clock: a server row moved back by the skew the test sets (fe#262).
  mirrorTimeOf: async (r: MirrorRecord & { server_clock?: true }) =>
    Date.parse(r.updated_at) - (r.server_clock ? mockSkewMs : 0),
  noteClockSkew: jest.fn(),
  pendingSaves: jest.fn(async () => ({ events: 0, listens: 0 })),
}));
jest.mock('./time-saved', () => ({ noteSilenceSaved: jest.fn(), flushTimeSaved: jest.fn() }));
// The flags the cached `/server` holds for every connection (undefined: never answered,
// which the outbox counts as a server that takes listening events).
let mockServerCaps: Record<string, boolean> | undefined;
jest.mock('@/api/provider', () => ({
  queryClient: {
    invalidateQueries: jest.fn(async () => {}),
    setQueryData: jest.fn(),
    setQueryDefaults: jest.fn(),
    fetchQuery: jest.fn(async () => ({})),
    getQueryData: jest.fn((key: readonly unknown[]) =>
      key[0] === 'server' && mockServerCaps ? { capabilities: mockServerCaps } : undefined,
    ),
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
    addHistory: async (_lib: number, _path: string, span: { from_pos: number; to_pos: number }) => {
      mockServer.history.push(span);
    },
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
  /** The tracks of the last load: where each file ends. */
  let loaded: PlaybackTrack[] = [];
  const svc = {
    onRemotePlay: jest.fn((_handler: () => void) => {}),
    onPauseAsked: jest.fn((_handler: () => void) => {}),
    onRemoteSeek: jest.fn(),
    onRemoteMove: jest.fn(
      (_handler: (index: number, position: number, checkpoint?: boolean) => void) => {},
    ),
    isCasting: jest.fn(() => false),
    onRateChange: jest.fn(),
    onSilenceSaved: jest.fn(),
    setup: jest.fn(async () => {}),
    configure: jest.fn(async () => {}),
    load: jest.fn(async (tracks: PlaybackTrack[], trackIndex: number, position: number) => {
      loaded = tracks;
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
    remotePause: async () => {
      svc.onPauseAsked.mock.lastCall![0]();
      await svc.pause();
    },
    remotePlay: async () => {
      svc.onRemotePlay.mock.lastCall![0]();
      await svc.play();
    },
    /** The engine plays on to `position` (seconds into the file). */
    at: (position: number, duration = snapshot.duration) => push({ position, duration }),
    /** The engine goes on into a later file by itself, at `position` in it (a run off the end
     * of a file it measured short). */
    runOff: (trackIndex: number, position: number) => push({ trackIndex, position }),
    /** The playing file plays to its end and the next one (`trackIndex`) loads and plays on, as
     * the web engine does it: `loading`, then `playing`, with nothing pressed. */
    advance: (trackIndex: number) => {
      push({ position: loaded[snapshot.trackIndex]?.duration ?? snapshot.position });
      push({ state: 'loading', trackIndex, position: 0 });
      push({ state: 'playing' });
    },
    /** The play buffers a moment and comes back where it is, as a web element does just
     * after it starts: `loading`, then `playing` again, with nothing pressed. */
    stall: () => {
      push({ state: 'loading' });
      push({ state: 'playing' });
    },
    /** The play buffers mid-stream and has not come back yet. */
    buffer: () => push({ state: 'loading' }),
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

/** Every tab's outbox opened by the test running, reset as it ends (`afterEach` below). */
const openOutboxes: (typeof import('./listening-outbox'))[] = [];

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
  let startInPlace!: typeof import('@/components/player/start-book').startBookInPlace;
  let outbox!: typeof import('./listening-outbox');
  let jumpUndo!: typeof import('./jump-undo');
  let types!: typeof import('./types');
  let downloads!: typeof import('@/downloads/store');
  let ids!: typeof import('@/lib/connection-id');
  try {
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      store = require('./store') as typeof import('./store');
      startInPlace = (
        require('@/components/player/start-book') as typeof import('@/components/player/start-book')
      ).startBookInPlace;
      outbox = require('./listening-outbox') as typeof import('./listening-outbox');
      jumpUndo = require('./jump-undo') as typeof import('./jump-undo');
      types = require('./types') as typeof import('./types');
      downloads = require('@/downloads/store') as typeof import('@/downloads/store');
      ids = require('@/lib/connection-id') as typeof import('@/lib/connection-id');
      /* eslint-enable @typescript-eslint/no-require-imports */
    });
    await store.initializePlayback();
  } finally {
    Object.assign(g, before);
  }
  openOutboxes.push(outbox);
  let gaveWay = 0;
  const listen = () => store.onGaveWayToTab(() => gaveWay++);
  if (!lateNotice) listen();
  return {
    engine,
    outbox,
    playAskedAt: store.localPlayAskedAt,
    startCard: () => startInPlace({ connectionId: 'c1', libraryId: 2, path: long.book.rel_path }),
    stay: () => {
      store.chooseLoadedPlace();
      store.standByPlace();
    },
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
    /** The tab's download of `which` lands, its files and chapters in `order`. */
    downloadLands: (which: { book: Book; chapters: ChaptersResponse }, order: string[]) => {
      const path = which.book.rel_path;
      const byPath = new Map(which.chapters.files.map((f) => [f.rel_path, f]));
      const files = order.map((rel, seq) => ({ ...byPath.get(rel)!, seq }));
      downloads.useDownloads.setState({
        entries: {
          [`c1:2:${path}`]: {
            connectionId: 'c1',
            libraryId: 2,
            path,
            title: which.book.title,
            status: 'downloaded',
            progress: 1,
            bytes: 0,
            totalBytes: 0,
            manifest: {
              book: which.book,
              chapters: {
                ...which.chapters,
                files,
                chapters: order.map((rel, index) => ({
                  ...which.chapters.chapters[0],
                  index,
                  file_index: index,
                  file_path: rel,
                  end: byPath.get(rel)!.duration,
                  book_offset: index * byPath.get(rel)!.duration,
                })),
              },
              files: order.map((relPath) => ({ relPath, localUri: `file:///dl/${relPath}` })),
              coverUri: null,
              savedAt: '2026-01-01T00:00:00Z',
            },
          },
        },
      });
    },
    /** The tab's connection aliases (`old -> new`), as after another tab's identity migration
     * renamed a connection it holds (`applyStored`). */
    alias: (map: Record<string, string>) => ids.setConnectionAliases(map),
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
  mockServerCaps = undefined;
  mockServer.events = [];
  mockServer.history = [];
  mockNoteFailure.mockClear();
  mockMirror.on = false;
  mockMirror.records.clear();
  mockMirror.saved = [];
  mockSkewMs = 0;
});
// A tab's look again at another tab's live span (`checkAgainLater`, 30 s on): a move's span
// is stored as it opens, so a sweep finds one live, and its timer must not outlive the
// file's modules.
afterEach(() => {
  for (const outbox of openOutboxes.splice(0)) outbox.resetOutboxForTests();
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
      await Promise.all(['c1', 'c2', 'old'].map((cid) => tab.outbox.flushOutbox(cid)));
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
    await a.engine.remotePlay();
    await until(() => b.player().snapshot.state === 'paused', 'B to give way');
    expect(a.player().snapshot.state).toBe('playing');
    expect([a.gaveWay(), b.gaveWay()]).toEqual([1, 1]);
  });

  // A Cast receiver's own controls (a TV remote) send no play signal: the receiver's play,
  // with nothing asked for in the page, is the listener's and claims the connection back.
  it('a play from the Cast receiver’s own controls claims it back', async () => {
    await a.start(5);
    a.engine.svc.isCasting.mockReturnValue(true);
    await sleep(5);
    await b.start(30);
    await until(() => a.player().snapshot.state === 'paused', 'A to give way');
    await sleep(5);
    await a.engine.svc.play(); // the receiver plays, no press in the page
    await until(() => b.player().snapshot.state === 'paused', 'B to give way');
    expect(a.player().snapshot.state).toBe('playing');
    expect([a.gaveWay(), b.gaveWay()]).toEqual([1, 1]);
  });

  // A receiver still buffering when its tab gave way can report the play it buffered for
  // before the pause reaches it: no play of the receiver's own, so it claims nothing back.
  it('a Cast receiver buffering as its tab gives way leaves the other tab playing', async () => {
    await a.start(5);
    a.engine.svc.isCasting.mockReturnValue(true);
    a.engine.buffer();
    const release = a.engine.holdPause();
    await sleep(5);
    await b.start(30);
    await until(() => a.gaveWay() === 1, 'A to give way');
    await a.engine.svc.play(); // the buffered play, sent before the pause landed
    release();
    await until(() => a.player().snapshot.state === 'paused', 'A to pause');
    await sleep(40);
    expect(b.player().snapshot.state).toBe('playing');
    expect(b.gaveWay()).toBe(0);
    // Once the receiver reported the pause, its own play claims the connection as before.
    await a.engine.svc.play();
    await until(() => b.player().snapshot.state === 'paused', 'B to give way');
    expect(a.player().snapshot.state).toBe('playing');
  });

  it('a newer play wins while an older OS Play is still waiting for audio', async () => {
    await a.start(5);
    await a.player().pause();
    const release = a.engine.holdPlay();
    const starting = a.engine.remotePlay();
    await sleep(5);
    await b.start(30);
    await until(() => a.gaveWay() === 1, 'the pending OS Play to give way');
    release();
    await starting;
    expect(a.player().snapshot.state).toBe('paused');
    expect(b.player().snapshot.state).toBe('playing');
  });

  it('an OS play paused before the engine starts stays paused', async () => {
    await a.start(5);
    await a.player().pause();
    const release = a.engine.holdPlay();
    const starting = a.engine.remotePlay();
    await a.engine.remotePause();
    release();
    await starting;
    expect(a.player().snapshot.state).toBe('paused');
  });

  it('a late playing report from A leaves B playing and keeps the time of A’s press', async () => {
    await a.start(5);
    const askedAt = a.playAskedAt();
    await sleep(5);
    await b.start(30);
    await until(() => a.gaveWay() === 1, 'A to give way');
    await a.engine.svc.play();
    await sleep(40);
    expect(a.playAskedAt()).toBe(askedAt);
    expect(a.player().snapshot.state).toBe('paused');
    expect(b.player().snapshot.state).toBe('playing');
    expect(b.gaveWay()).toBe(0);
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

  // Another tab's identity migration renamed the connection (`old` -> `c1`) after A loaded
  // its book: B's play under the new id is of the same connection.
  it('a tab whose stream died under the id its connection was renamed from is stopped too', async () => {
    a.alias({ old: 'c1' });
    await a.start(5, 'old');
    a.engine.fail();
    await sleep(5); // B's play is asked for later than A's
    await b.start(30, 'c1');
    await until(() => a.engine.svc.pause.mock.calls.length === 1, "A's engine to stop");
    expect(a.player().snapshot.state).toBe('error');
    expect(b.player().snapshot.state).toBe('playing');
  });

  // The same rename: B, which loaded the book under the new id, answers A's play with where
  // it stopped, and A (under the old id) takes that place.
  it('a tab on the id its connection was renamed from takes the place the other tab answers', async () => {
    a.alias({ old: 'c1' });
    b.alias({ old: 'c1' });
    await a.start(5, 'old');
    await sleep(10);
    a.engine.at(10);
    await b.start(30, 'c1');
    await until(() => a.player().snapshot.state === 'paused', 'A to give way');
    await sleep(10);
    b.engine.at(40);
    await a.player().toggle();
    await until(() => b.player().snapshot.state === 'paused', 'B to give way');
    await until(() => a.player().snapshot.position === 40, "A to take B's place");
    await a.player().pause();
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

  it('a newer tab starts while the book card waits for its item and chapters', async () => {
    let finish!: () => void;
    mockBookSource.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve(long))),
    );
    const card = a.startCard();
    await until(() => !!finish, 'A to ask for its book');
    await sleep(5);
    await b.start(30, 'c1', long);
    await sleep(40);
    finish();
    await card;
    expect(a.player().nowPlaying?.path).toBe(long.book.rel_path);
    expect(a.engine.svc.play).not.toHaveBeenCalled();
    expect(a.playAskedAt()).toBeLessThan(b.playAskedAt());
    expect(b.player().snapshot.state).toBe('playing');
  });

  it('a newer press wins while the first tab is still looking up its book', async () => {
    let resume!: () => void;
    mockLoadProgress.mockImplementationOnce(
      () => new Promise((resolve) => (resume = () => resolve({ kind: 'empty' }))),
    );
    const starting = a.open(long);
    await until(() => !!resume, 'A to look up its place');
    await sleep(5);
    await b.start(30, 'c1', long);
    await sleep(40);
    resume();
    await starting;
    expect(a.playAskedAt()).toBeLessThan(b.playAskedAt());
    expect(a.engine.svc.play).not.toHaveBeenCalled();
    expect(b.player().snapshot.state).toBe('playing');
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

  it('only the playing tab answers when a third tab starts during another tab’s load', async () => {
    const c = await openTab(browser);
    const answers = answersOn(browser);
    const release = b.engine.holdLoad();
    try {
      await a.start(5, 'c1', long);
      await sleep(40);
      a.engine.at(38);
      const starting = b.start(12, 'c1', long);
      await until(() => b.engine.svc.load.mock.calls.length === 1, 'B to load');
      await c.open(long);
      await until(() => a.gaveWay() === 1 && b.gaveWay() === 1, 'both tabs to give way');
      release();
      await starting;
      await until(() => c.player().snapshot.position === 38, 'C to take A’s place');
      await sleep(40);
      expect(answers()).toEqual([38]);
      expect(c.engine.svc.seekTo.mock.calls).toEqual([[38]]);
    } finally {
      release();
      await c.player().stop();
      await c.outbox.storeOpenSpan(null);
    }
  });

  it('a tab buffering mid-play answers with where it was heard to', async () => {
    const answers = answersOn(browser);
    await a.start(5, 'c1', long);
    await sleep(40);
    a.engine.at(38);
    a.engine.buffer();
    await sleep(5);
    await b.open(long);
    await until(() => b.player().snapshot.position === 38, 'B to take A’s place');
    expect(answers()).toEqual([38]);
    expect(a.player().snapshot.state).not.toBe('playing');
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
      await b.engine.remotePlay(); // no press in the page
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
      await b.engine.remotePlay(); // no press in the page
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
      // Nor a second give-way: one pause and one notice, and the place the listener chose
      // in A is the one it plays from, whatever B has saved since.
      expect(a.engine.svc.pause).toHaveBeenCalledTimes(1);
      expect(a.gaveWay()).toBe(1);
      b.engine.at(60);
      await b.save();
      await a.player().toggle();
      await until(() => b.player().snapshot.state === 'paused', 'B to give way');
      await sleep(40);
      expect(a.engine.svc.seekTo.mock.calls).toEqual([[300]]);
      expect(a.player().snapshot).toMatchObject({ state: 'playing', position: 300 });
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

    it('Stay keeps the chosen place and its next span when a takeover answer arrives', async () => {
      await aheadOfItsSave(a, b);
      const release = browser.hold();
      await b.player().toggle();
      b.stay();
      release();
      await until(() => a.gaveWay() === 1, 'A to give way');
      await sleep(40);
      expect(b.engine.svc.seekTo.mock.calls).toEqual([[35]]);
      b.engine.at(42);
      await b.player().pause();
      await until(() => listens().some((e) => e.to_pos === 42), 'the listening after Stay');
      expect(heard()).toContainEqual([35, 42, 'jump']);
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
    /** The 5 s bound (`TAB_MOVE_MAX_MS`) runs out in 20 ms; every other timer is real. */
    function shortenTabMoveBound() {
      const realTimeout = globalThis.setTimeout;
      return jest
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation(((fn: () => void, ms?: number) =>
          realTimeout(fn, ms === 5_000 ? 20 : ms)) as typeof setTimeout);
    }

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

    // fe#262: the server's row of this browser's own place, read back after the claim, is
    // stamped by a server clock ahead: by the browser's it is from before the claim.
    it.each([
      [0, true],
      [60_000, false],
    ])(
      'a server row stamped after the claim by a clock %i ms ahead moves it: %s',
      async (skew, moves) => {
        await playedPast(a, b);
        mockSkewMs = skew;
        const key = mirrorKey('c1', long.book.library_id, long.book.rel_path);
        const {
          file: _file,
          file_pos: _pos,
          ...saved
        } = mockMirror.records.get(key) as MirrorRecord & {
          file?: string;
          file_pos?: number;
        };
        mockMirror.records.set(key, {
          ...saved,
          position: 70,
          updated_at: new Date(Date.now() + 30_000).toISOString(),
          server_clock: true,
        } as MirrorRecord);
        await a.player().toggle();
        await until(() => b.player().snapshot.state === 'paused', 'B to give way');
        expect(a.engine.svc.seekTo.mock.calls).toEqual(moves ? [[70]] : []);
      },
    );

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

    // Left standing, the ask for the 900 s the engine never went to read the engine's next
    // file as a run off a file it measured short (`engineFault`): an error, and a pause.
    it('a move the engine refuses leaves no ask standing: its next file is no fault', async () => {
      mockMirror.on = true;
      await a.start(5, 'c1', parts);
      await sleep(10);
      a.engine.at(30);
      await b.start(30, 'c1', parts);
      await until(() => a.player().snapshot.state === 'paused', 'A to give way');
      await sleep(10);
      b.engine.at(900);
      await b.player().pause();
      const key = mirrorKey('c1', 2, parts.book.rel_path);
      await until(() => mockMirror.records.get(key)?.position === 900, "B's place in the mirror");
      const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        a.engine.svc.seekTo.mockRejectedValueOnce(new Error('no seek'));
        await a.player().toggle();
        expect(a.player().snapshot).toMatchObject({ state: 'playing', position: 30 });
        // The lock screen's next: the engine reports the second file.
        await a.engine.svc.skipToTrack(1, 0);
        expect(a.player().snapshot).toMatchObject({ state: 'playing', trackIndex: 1, position: 0 });
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

      await a.engine.remotePlay(); // no press in the page: the engine plays from 30
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

    // fe#262: a seek that never settled left the tab catching up for good: no span, no
    // history and no save until another book.
    it('a move there that never settles stops holding the play back after 5 s', async () => {
      await playedPast(a, b);
      b.engine.at(90);
      await b.save();
      const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const shortened = shortenTabMoveBound();
      try {
        a.engine.svc.seekTo.mockImplementationOnce(() => new Promise<void>(() => {}));
        await a.engine.remotePlay(); // no press in the page: the engine plays from 30
        await until(() => b.player().snapshot.state === 'paused', 'B to give way');
        await until(() => a.engine.svc.seekTo.mock.calls.length === 1, 'A to move');
        shortened.mockRestore();
        // Over: B's answer (where it stopped) is taken now, and that move settles.
        await until(() => a.engine.svc.seekTo.mock.calls.length === 2, 'A to move again');
        await sleep(10);
        a.engine.at(100);
        await a.player().pause();
        await until(() => listens().length === 3, 'the three spans on the server');
        expect(heard()).toEqual([
          [5, 30, 'jump'],
          [30, 90, 'jump'],
          [90, 100, 'resume'],
        ]);
      } finally {
        shortened.mockRestore();
        warned.mockRestore();
      }
    });

    // fe#351: a seek on the faulted book called the fault off and never settled. A's press on
    // the book, still in error, reloads it at the place B left (`retry`, as for any book in
    // error), so no move there is given up on, and the seek refused later brings no fault back
    // over the reload.
    it('a press on the book in error with a move out reloads at the place another tab left', async () => {
      mockMirror.on = true;
      await a.start(30, 'c1', parts);
      await sleep(10);
      a.engine.runOff(1, 0.4); // file 1 measured short: the engine ran on into file 2
      await until(() => a.player().snapshot.state === 'error', 'A to fault');
      // A seek on the faulted book calls the fault off; the engine refuses it only later.
      let refuse: (e: Error) => void = () => {};
      a.engine.svc.skipToTrack.mockImplementationOnce(
        () => new Promise<void>((_, reject) => (refuse = reject)),
      );
      const seek = a.player().seekInTrack(60);
      await sleep(10);
      // B plays the book on to 605 and stops there.
      await b.start(600, 'c1', parts);
      await sleep(10);
      b.engine.at(605);
      await b.save();
      await b.player().pause();
      await sleep(40);
      a.engine.svc.load.mockClear();
      await a.player().toggle();
      expect(a.engine.svc.load.mock.lastCall?.slice(1, 3)).toEqual([0, 605]);
      expect(a.player().snapshot.state).toBe('playing');
      refuse(new Error('refused'));
      await expect(seek).rejects.toThrow('refused');
      a.engine.svc.pause.mockClear();
      a.engine.at(610); // playing on from the reload
      await sleep(10);
      expect(a.engine.svc.pause).not.toHaveBeenCalled();
      expect(a.player().snapshot).toMatchObject({ state: 'playing', position: 610 });
    });

    // A seek on the faulted book called the fault off and never settled; a play from the OS
    // media controls then moved to the other tab's place, a move given up on. The engine went on
    // playing from wherever it was: a later move it refuses brings back no fault from before.
    it('a move refused after one given up on brings back no fault an earlier ask called off', async () => {
      mockMirror.on = true;
      await a.start(30, 'c1', parts);
      await sleep(10);
      a.engine.runOff(1, 0.4); // file 1 measured short: the engine ran on into file 2
      await until(() => a.player().snapshot.state === 'error', 'A to fault');
      a.engine.svc.skipToTrack.mockImplementationOnce(() => new Promise<void>(() => {}));
      void a.player().seekInTrack(60);
      await sleep(10);
      a.engine.runOff(0, 60); // the engine went there; the call never says so
      // B plays the book on to 605 and stops there.
      await b.start(600, 'c1', parts);
      await sleep(10);
      b.engine.at(605);
      await b.save();
      await b.player().pause();
      await sleep(40);
      const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const shortened = shortenTabMoveBound();
      const { seekTo, skipToTrack } = a.engine.svc;
      const impls = [seekTo.getMockImplementation(), skipToTrack.getMockImplementation()] as const;
      const moves = () => seekTo.mock.calls.length + skipToTrack.mock.calls.length;
      try {
        // The move to B's place never settles; every move after it is refused.
        const before = moves();
        const move = () =>
          moves() === before + 1
            ? new Promise<void>(() => {})
            : Promise.reject(new Error('refused'));
        seekTo.mockImplementation(move);
        skipToTrack.mockImplementation(move);
        await a.engine.remotePlay(); // no press in the page
        await until(() => moves() === before + 1, 'A to move');
        await until(() => warned.mock.calls.length > 0, 'A to give the move up');
        shortened.mockRestore();
        await a
          .player()
          .seekInTrack(700)
          .catch(() => undefined);
        expect(moves()).toBeGreaterThan(before + 1);
        a.engine.svc.pause.mockClear();
        a.engine.at(620); // playing on
        await sleep(10);
        expect(a.engine.svc.pause).not.toHaveBeenCalled();
        expect(a.player().snapshot.state).toBe('playing');
      } finally {
        shortened.mockRestore();
        warned.mockRestore();
        seekTo.mockImplementation(impls[0]);
        skipToTrack.mockImplementation(impls[1]);
      }
    });

    // A move given up on (not refused) can still land. Left as it was, the floor put back at
    // the place the engine had refused every save of a landing far behind it, and the span
    // opened at that place ran on over the audio in between.
    describe('a move there that lands after it was given up', () => {
      /** A's next seek stays out until the returned `land`; the 5 s bound is 20 ms. */
      function slowSeek() {
        let target = 0;
        let accept = () => {};
        a.engine.svc.seekTo.mockImplementationOnce((position: number) => {
          target = position;
          return new Promise<void>((resolve) => (accept = resolve));
        });
        const shortened = shortenTabMoveBound();
        return {
          accept: () => accept(),
          land: () => {
            a.engine.at(target);
            accept();
          },
          restore: () => shortened.mockRestore(),
        };
      }

      it.each([
        { cast: false, target: 900 },
        { cast: false, target: 40 },
        { cast: true, target: 900 },
      ])(
        'a save due on the late landing at $target skips the unheard stretch (Cast $cast)',
        async ({ cast, target }) => {
          await playedPast(a, b);
          // B is paused, so no answer of B's moves A there.
          b.engine.at(target);
          await b.player().pause();
          await until(() => listens().length === 2, "B's span on the server");
          const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});
          const seek = slowSeek();
          try {
            await a.player().toggle();
            seek.restore();
            expect(a.player().snapshot).toMatchObject({ state: 'playing', position: 30 });
            await sleep(10);
            if (cast) {
              // The seek call settles before the receiver's status reaches the store.
              a.engine.svc.isCasting.mockReturnValue(true);
              seek.accept();
              await sleep(0);
            }
            // The landing itself drives the overdue save before the seek callback can run.
            const now = Date.now;
            const clock = jest.spyOn(Date, 'now').mockImplementation(() => now() + 15_000);
            try {
              if (cast) a.engine.svc.onRemoteMove.mock.lastCall![0](0, target);
              seek.land();
              await sleep(0);
            } finally {
              clock.mockRestore();
            }
            a.engine.at(target + 10);
            await a.player().pause();
            await until(() => listens().length === 3, 'the three spans on the server');
            expect(heard()).toEqual([
              [5, 30, 'jump'],
              [30, target, 'jump'],
              [target, target + 10, 'resume'],
            ]);
          } finally {
            seek.restore();
            warned.mockRestore();
          }
        },
      );

      // On Cast a remote move at the place is taken as the late landing only while the
      // call could still land. Past `ASK_SETTLE_MAX_MS` it is the listener's own move: the
      // span from 900 starts as a jump, and the listening at A's place before it is kept.
      it.each([{ late: false }, { late: true }])(
        'on Cast, a move to the place after the call is long out is the listener’s (late $late)',
        async ({ late }) => {
          await playedPast(a, b);
          b.engine.at(900);
          await b.player().pause();
          await until(() => listens().length === 2, "B's span on the server");
          const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});
          const seek = slowSeek(); // never accepted
          try {
            await a.player().toggle();
            seek.restore();
            expect(a.player().snapshot).toMatchObject({ state: 'playing', position: 30 });
            a.engine.svc.isCasting.mockReturnValue(true);
            await sleep(10);
            const now = Date.now;
            const clock = jest
              .spyOn(Date, 'now')
              .mockImplementation(() => now() + (late ? 15_000 : 0));
            try {
              a.engine.svc.onRemoteMove.mock.lastCall![0](0, 900);
              a.engine.at(900);
              await sleep(10);
              a.engine.at(910);
              await a.player().pause();
            } finally {
              clock.mockRestore();
            }
            await until(() => listens().some((e) => e.to_pos === 910), "A's span to 910");
            const starts = heard().map(([from, , start]) => [from, start]);
            if (late) {
              expect(starts).toContainEqual([30, 'resume']);
              expect(starts).toContainEqual([900, 'jump']);
            } else {
              expect(starts).not.toContainEqual([30, 'resume']);
              expect(heard()).toContainEqual([900, 910, 'resume']);
            }
          } finally {
            seek.restore();
            warned.mockRestore();
          }
        },
      );

      // Stay before the landing chooses the place the book shows, but the engine still goes
      // where the move lands: the landing is taken as without it.
      it.each([{ stay: false }, { stay: true }])(
        'far behind: the play that follows still saves its place (Stay $stay)',
        async ({ stay }) => {
          mockMirror.on = true;
          await a.start(5, 'c1', long);
          await sleep(10);
          a.engine.at(300);
          await b.start(300, 'c1', long);
          await until(() => a.player().snapshot.state === 'paused', 'A to give way');
          // The listener went back in B (more than the save guard's slip tolerance), which
          // then paused: no answer of B's moves A there.
          await b.player().seekBook(12);
          await sleep(10);
          b.engine.at(15);
          await b.player().pause();
          const key = mirrorKey('c1', 2, long.book.rel_path);
          await until(() => mockMirror.records.get(key)?.position === 15, "B's place saved");
          const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});
          const seek = slowSeek();
          try {
            await a.player().toggle();
            seek.restore();
            expect(a.player().snapshot).toMatchObject({ state: 'playing', position: 300 });
            if (stay) a.stay();
            seek.land();
            await sleep(10);
            a.engine.at(20);
            await a.save();
            expect(mockMirror.records.get(key)?.position).toBe(20);
            await a.player().pause();
          } finally {
            seek.restore();
            warned.mockRestore();
          }
        },
      );
    });

    it('a seek during the move starts the listening span at the listener’s place', async () => {
      await playedPast(a, b);
      b.engine.at(90);
      await b.player().pause();
      await until(() => listens().length === 2, 'B to save its place');
      let settle!: () => void;
      a.engine.svc.seekTo.mockImplementationOnce(
        () => new Promise<void>((resolve) => (settle = resolve)),
      );
      await a.engine.remotePlay();
      await until(() => !!settle, 'A to begin the move');
      await a.player().seekBook(300);
      settle();
      await sleep(10);
      a.engine.at(310);
      await a.player().pause();
      await until(() => listens().some((e) => e.to_pos === 310), 'the span after the seek');
      expect(heard()).toContainEqual([300, 310, 'jump']);
    });

    it('a play that buffers during that move begins its history where the move lands', async () => {
      // A server that takes no listening events: the listening is its `POST /history`.
      mockServerCaps = { listening_sync: false };
      await playedPast(a, b);
      b.engine.at(90);
      await b.save();

      // A plays by itself from its 30 s, and its move to B's 90 s is still out.
      let land: () => void = () => {};
      a.engine.svc.seekTo.mockImplementationOnce(
        (position: number) =>
          new Promise<void>((resolve) => {
            land = () => {
              a.engine.at(position);
              resolve();
            };
          }),
      );
      await a.engine.remotePlay();
      await until(() => a.engine.svc.seekTo.mock.calls.length === 1, 'A to move');
      a.engine.stall(); // it buffers and comes back, still at 30 s
      land();
      await until(() => a.player().snapshot.position === 90, 'the move to land');
      await sleep(40);

      // Long enough to keep (`MIN_HISTORY_MS`).
      const now = Date.now;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now() + 30_000);
      try {
        a.engine.at(100);
        await a.player().pause();
      } finally {
        clock.mockRestore();
      }
      await until(() => mockServer.history.length === 1, 'the span on the server');
      // Nothing for the 30 s to 90 s it moved over.
      expect(mockServer.history).toEqual([expect.objectContaining({ from_pos: 90, to_pos: 100 })]);
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
        await a.engine.remotePlay();
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
      await a.engine.remotePlay();
      await until(() => a.engine.svc.seekTo.mock.calls.length === 1, 'A to move');
      await a.start(100, 'c1', other);
      await sleep(10);
      a.engine.at(110, 1200);
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

    it.each(['foreground', 'play', 'remote', 'seek'] as const)(
      'follows the other tab once a file-changing web swap lands (%s)',
      async (action) => {
        mockMirror.on = true;
        // The stream starts at file 2, the download also holds file 1 before it.
        const listed = { ...parts.book, files: parts.chapters.files.slice(1) };
        await a.player().playBook('c1', 2, listed, undefined, 30);
        await sleep(5);
        await b.start(1400, 'c1', parts);
        await until(() => a.gaveWay() === 1, 'A to give way');
        b.engine.at(210);
        await b.player().pause();
        const key = mirrorKey('c1', 2, parts.book.rel_path);
        await until(() => mockMirror.records.get(key)?.position === 1410, 'B to save');
        // On the web the old element stays paused while the download buffers.
        const release = Promise.withResolvers<void>();
        type Swap = NonNullable<PlaybackService['swapTo']>;
        const swapping = jest.fn<ReturnType<Swap>, Parameters<Swap>>(
          async (_tracks, index, _pos, _chapters, _book, onSwitch) => {
            await release.promise;
            onSwitch?.();
            a.engine.runOff(index, a.player().snapshot.position);
            return 'swapped';
          },
        );
        a.engine.svc.swapTo = swapping;
        a.downloadLands(
          parts,
          parts.chapters.files.map((f) => f.rel_path),
        );
        let play: Promise<void> | undefined;
        try {
          await until(() => swapping.mock.calls.length === 1, 'the swap to start');
          if (action === 'play') play = a.player().toggle();
          else if (action === 'remote') play = a.engine.remotePlay();
          else a.lookAt();
          await sleep(10);
          expect(a.engine.svc.seekTo).not.toHaveBeenCalled();
          expect(a.engine.svc.skipToTrack).not.toHaveBeenCalled();
          await a.save();
          expect(mockMirror.records.get(key)?.position).toBe(1410);
          if (action === 'seek') await a.player().seekBook(71);
          if (action === 'foreground') {
            b.engine.at(215);
            await b.save();
            expect(mockMirror.records.get(key)?.position).toBe(1415);
          }
        } finally {
          release.resolve();
        }
        await play;
        await until(() => a.player().nowPlaying?.queue.tracks.length === 3, 'the swap to land');
        if (action === 'seek') {
          await sleep(40);
          expect(a.engine.svc.seekTo).toHaveBeenCalledTimes(1);
          expect(a.player().snapshot.position).toBe(71);
        } else {
          const expected = action === 'foreground' ? 215 : 210;
          await until(() => a.player().snapshot.position === expected, 'A to follow B');
          expect(a.player().snapshot).toMatchObject({
            trackIndex: 1,
            state: action === 'foreground' ? 'paused' : 'playing',
          });
          expect(a.engine.svc.seekTo).toHaveBeenCalledTimes(1);
        }
      },
    );

    it('a Retry onto a download in another order starts a book the other tab finished from its start', async () => {
      mockMirror.on = true;
      // Started from its file list alone: a download in another order keeps that order.
      const listed = { ...parts.book, files: parts.chapters.files };
      await a.player().playBook('c1', 2, listed, undefined, 30);
      a.engine.fail();
      await sleep(5);
      await b.start(30, 'c1', parts);
      await until(() => a.engine.svc.pause.mock.calls.length === 1, "A's engine to stop");
      // B finished the book and plays no more: the record its finish writes.
      await b.player().pause();
      mockMirror.records.set(mirrorKey('c1', 2, parts.book.rel_path), {
        connectionId: 'c1',
        libraryId: 2,
        path: parts.book.rel_path,
        position: 3600,
        finished: true,
        device_id: 'dev-1',
        updated_at: new Date().toISOString(),
      });
      const [one, two, three] = parts.chapters.files.map((f) => f.rel_path);
      a.downloadLands(parts, [three, one, two]);
      await sleep(5);

      await a.player().retry();
      // From the download's start (its first file, 3.mp3), not from 1.mp3, which the
      // download plays second.
      const [tracks, index, position] = a.engine.svc.load.mock.lastCall as unknown as [
        { url: string }[],
        number,
        number,
      ];
      expect([tracks[index].url, index, position]).toEqual([`file:///dl/${three}`, 0, 0]);
    });
  });
});

describe("the Undo jump chip after a tab takes another tab's place", () => {
  it('a Retry in a reordered download establishes a new baseline for Undo', async () => {
    const a = await openTab(fakeBrowser());
    const stop = a.watchJumps();
    try {
      await a
        .player()
        .playBook('c1', 2, { ...parts.book, files: parts.chapters.files }, undefined, 30);
      await sleep(3_100);
      a.engine.at(110);
      a.engine.fail();
      const [one, two, three] = parts.chapters.files.map((f) => f.rel_path);
      a.downloadLands(parts, [three, one, two]);
      await a.player().retry();
      expect(a.player().snapshot).toMatchObject({ trackIndex: 1, position: 110 });
      expect(a.undoFrom()).toBeNull();
      a.engine.at(330, 1200);
      expect(a.undoFrom()).toBe(parts.chapters.files[2].duration + 110);
      // A later low engine report must still respect the place Retry loaded in this order.
      a.engine.at(0);
      a.engine.fail();
      await a.player().retry();
      expect(a.player().snapshot.trackIndex).toBe(1);
      expect(a.player().snapshot.position).toBeGreaterThanOrEqual(110);
    } finally {
      stop();
      await a.player().stop();
    }
  });

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
