import type { Book, ChaptersResponse, Progress } from '@/api/types';

import type { ResumeLookup } from './progress-sync';
import type { PlaybackService, PlaybackSnapshot, PlaybackState, SwapOutcome } from './types';

// --- Mocks -----------------------------------------------------------------
// The store talks to the playback engine only through createPlaybackService()
// (Metro resolves the native/web impl). We swap in a fake whose `subscribe`
// captures the listener so a test can push engine snapshots and drive the store's
// state-transition logic (save-loop start/stop, persist-on-stop) directly.

let pushSnapshot: (s: PlaybackSnapshot) => void = () => {};
/** The seek the store handed the engine for the OS media controls (`onRemoteSeek`). */
let remoteSeek: ((positionInTrack: number) => void) | null = null;
/** The native engine's Phase 6 handlers the store registered. */
type TrackPlace = (trackIndex: number, positionInTrack: number, checkpoint?: boolean) => void;
let remoteMove: TrackPlace | null = null;
let rateChange: ((rate: number) => void) | null = null;
let silenceSaved: ((total: number) => void) | null = null;
/** Android's word that the engine was asked to play (`onPlayAsked`), or stopped wanting to
 * (`onPauseAsked`). */
let playAsked: (() => void) | null = null;
let pauseAsked: (() => void) | null = null;
/** The route switch's own load, as the store is told of it (`onOwnLoad`). */
type OwnLoad = (trackIndex: number, positionInTrack: number, loaded: Promise<unknown>) => void;
let ownLoad: OwnLoad | null = null;
const mockSvc = {
  onPlayAsked: jest.fn((handler: (() => void) | null) => {
    playAsked = handler;
  }),
  onOwnLoad: jest.fn((handler: OwnLoad | null) => {
    ownLoad = handler;
  }),
  onPauseAsked: jest.fn((handler: (() => void) | null) => {
    pauseAsked = handler;
  }),
  onRemoteSeek: jest.fn((handler: ((positionInTrack: number) => void) | null) => {
    remoteSeek = handler;
  }),
  onRemoteMove: jest.fn((handler: TrackPlace | null) => {
    remoteMove = handler;
  }),
  onRateChange: jest.fn((handler: ((rate: number) => void) | null) => {
    rateChange = handler;
  }),
  onSilenceSaved: jest.fn((handler: ((total: number) => void) | null) => {
    silenceSaved = handler;
  }),
  setup: jest.fn(async () => {}),
  configure: jest.fn(async () => {}),
  load: jest.fn(async () => {}),
  play: jest.fn(async () => {}),
  pause: jest.fn(async () => {}),
  seekTo: jest.fn(async () => {}),
  skipToTrack: jest.fn(async () => {}),
  setRate: jest.fn(async () => {}),
  setVolume: jest.fn(async () => {}),
  reset: jest.fn(async () => {}),
  getSnapshot: jest.fn(() => ({ ...INITIAL })),
  subscribe: jest.fn((listener: (s: PlaybackSnapshot) => void) => {
    pushSnapshot = listener;
    return () => {};
  }),
} as unknown as PlaybackService;

const INITIAL: PlaybackSnapshot = {
  state: 'idle',
  trackIndex: 0,
  position: 0,
  duration: 0,
  rate: 1,
};

jest.mock('./service', () => ({
  createPlaybackService: () => mockSvc,
}));

// Spy on the progress-sync layer so we can assert what (if anything) gets saved,
// and so playBook's resume/flush calls are inert.
const mockSaveProgress = jest.fn(async (..._args: unknown[]) => {});
const mockLoadInitialProgress = jest.fn(async (..._args: unknown[]): Promise<ResumeLookup> => ({
  kind: 'empty',
}));
const mockReadMirror = jest.fn(async (..._args: unknown[]): Promise<unknown> => null);
type Stamped = { updated_at: string };
// No clock skew is known here: the two stamps as they are.
const mockMirrorIsNewest = jest.fn(
  async (record: Stamped, place: Stamped): Promise<boolean> =>
    Date.parse(record.updated_at) >= Date.parse(place.updated_at),
);
// The bookmarks waiting on the device: their last send before a removal (fe#356).
const mockSendBookmarks = jest.fn(async (_cid: string) => {});
jest.mock('./annotation-outbox', () => ({
  sendBookmarksBeforeRemoval: (cid: string) => mockSendBookmarks(cid),
}));
jest.mock('./progress-sync', () => ({
  saveProgress: (...args: unknown[]) => mockSaveProgress(...args),
  // This device's own record between two saves (`placeLoop`).
  writeMirror: jest.fn(async () => {}),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
  loadInitialProgress: (...args: unknown[]) => mockLoadInitialProgress(...args),
  readMirror: (...args: unknown[]) => mockReadMirror(...args),
  mirrorIsNewest: (...args: [Stamped, Stamped]) => mockMirrorIsNewest(...args),
}));

// Smart Speed's counts: what the store hands over, and when it asks for a write.
const mockNoteSilenceSaved = jest.fn((..._a: unknown[]) => {});
const mockFlushTimeSaved = jest.fn(async () => {});
jest.mock('./time-saved', () => ({
  noteSilenceSaved: (...a: unknown[]) => mockNoteSilenceSaved(...a),
  flushTimeSaved: () => mockFlushTimeSaved(),
}));

// Keep React Query out of the unit test.
// `fetchQuery`/`getQueryData` answer the web transcode negotiation's `/server` read;
// `cancelQueries` is the fail-fast read's first step (`fetchFailFast`).
const mockFetchQuery = jest.fn(async (..._a: unknown[]): Promise<unknown> => ({}));
jest.mock('@/api/provider', () => ({
  queryClient: {
    invalidateQueries: jest.fn(),
    setQueryData: jest.fn(),
    // The downloads store's offline cache rules (`releaseOfflineBook` on a removal).
    setQueryDefaults: jest.fn(),
    fetchQuery: (...a: unknown[]) => mockFetchQuery(...a),
    // A server without listening_sync (the PUT path), unless a test says otherwise.
    getQueryData: jest.fn((k: readonly unknown[]) =>
      k?.[0] === 'server' ? { capabilities: {} } : undefined,
    ),
    cancelQueries: jest.fn(async () => {}),
  },
}));

// playBook fires an auto-download of the started book through @/lib/network's policy gate;
// mock it so the network probe is deterministic (default: allowed).
const mockCanAutoDownload = jest.fn((..._a: unknown[]) => Promise.resolve(true));
jest.mock('@/lib/network', () => ({
  canAutoDownload: (...a: unknown[]) => mockCanAutoDownload(...a),
}));

// playBook resolves its ApiClient from the connection id via resolveClient(); return a
// fake so saves/history/cover URLs work without a real session. Exposed as a jest.fn so a
// test can force `null` (a connection whose token failed to hydrate - see the offline
// downloaded-book case). clearAllMocks() keeps this default implementation.
const fakeClient = {
  coverUrl: (lib: number, path: string) => `cover:${lib}:${path}`,
  streamUrl: (lib: number, path: string, _download?: boolean, opts?: { transcode?: boolean }) =>
    `stream:${lib}:${path}${opts?.transcode ? ':transcode' : ''}`,
  authHeaders: () => ({ Authorization: 'Bearer x' }),
  addHistory: jest.fn(async () => {}),
};
const mockResolveClient = jest.fn((_cid: string): typeof fakeClient | null => fakeClient);
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (cid: string) => mockResolveClient(cid),
  sessionReady: jest.fn(() => true),
}));
// The save's client, read at each call (its own tests: `live-client.test.ts`): here the one
// the connection resolves to when the save is made, so a test sees which client it went to.
const mockLiveClient = jest.fn((cid: string) => mockResolveClient(cid));
jest.mock('@/api/live-client', () => ({
  liveClient: (cid: string) => mockLiveClient(cid),
}));

/* eslint-disable import/first */
import { Platform } from 'react-native';

import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { engine as downloadEngine } from '@/downloads/engine';
import { isDeclined, useDownloads } from '@/downloads/store';
import type { DownloadEntry, DownloadManifest } from '@/downloads/types';
import { resetProfilesForTests, switchProfile, useProfiles } from '@/stores/profiles';
import * as session from '@/stores/session';
import { useSettings } from '@/stores/settings';

import { bookFileSpecs } from './book-queue';
import { clearJumpUndo, startJumpUndo, useJumpUndo } from './jump-undo';
import { flushConnection, writeMirror } from './progress-sync';
import { useSleepTimer } from './sleep-timer';
import { useReachability } from '@/api/reachability';
import { AutoplayBlockedError, PlaybackStartError } from './types';
import {
  ASK_SETTLE_MAX_MS,
  DOWNLOADED_PLACE_WAIT_MS,
  FAULT_HOLD_MS,
  flushHistoryOnHide,
  holdSaves,
  LONG_PAUSE_MS,
  localMoveCount,
  onPickedUpAgain,
  selectBookKey,
  selectBookPosition,
  selectCurrentChapter,
  selectEndsPartial,
  selectIsEnded,
  selectIsPlaying,
  selectIsTransportLive,
  stopPlaybackForConnection,
  teardownBeforeTokenRevoke,
  initializePlayback,
  usePlayer,
  watchPageHide,
} from './store';
/* eslint-enable import/first */

// --- Fixtures --------------------------------------------------------------

function makeBook(p: Partial<Book> = {}): Book {
  return {
    id: 1,
    library_id: 2,
    rel_path: 'A/Book.m4b',
    is_folder: false,
    title: 'A Book',
    author: 'Author',
    series: '',
    series_index: 0,
    narrator: '',
    duration: 100, // single-file book, 100s total
    format: 'm4b',
    size: 0,
    ...p,
  };
}

/** A podcast episode on its server (one file, `Show/Ep.mp3`). */
function makeEpisode(p: Partial<Book> = {}): Book {
  return makeBook({
    rel_path: 'Show/Ep.mp3',
    title: 'An Episode',
    format: 'mp3',
    episode: {
      show_path: 'Show',
      published: null,
      season: null,
      episode: null,
      episode_type: 'full',
      explicit: false,
      downloaded: true,
      duration_source: 'file',
      removed: false,
    },
    ...p,
  });
}

function makeProgress(p: Partial<Progress> = {}): Progress {
  return {
    library_id: 2,
    path: 'A/Book.m4b',
    position: 0,
    duration: 100,
    finished: false,
    playback_speed: 1,
    version: 0,
    device_id: 'dev',
    updated_at: '2026-01-01T00:00:00Z',
    ...p,
  };
}

function snap(state: PlaybackState, position: number, extra: Partial<PlaybackSnapshot> = {}) {
  return { state, trackIndex: 0, position, duration: 100, rate: 1, ...extra } as PlaybackSnapshot;
}

/** The query keys handed to the mocked React Query client since the last clear. */
function invalidatedKeys(): unknown[] {
  return (queryClient.invalidateQueries as jest.Mock).mock.calls.map(
    (c) => (c[0] as { queryKey: unknown }).queryKey,
  );
}

/** The positions saved since the last clear. */
function savedPositions(): number[] {
  return mockSaveProgress.mock.calls.map((c) => (c[1] as { position: number }).position);
}

/** Flush a few microtask turns so a fire-and-forget `void persist()` chain settles. */
async function flushMicrotasks(turns = 6) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Start a book so `nowPlaying` + the engine subscription are wired up. Loaded
 * through connection `c1` unless a test overrides it. */
async function startBook(book: Book = makeBook(), startPos = 0, cid = 'c1') {
  await usePlayer.getState().playBook(cid, 2, book, undefined, startPos);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockCanAutoDownload.mockResolvedValue(true);
  mockReadMirror.mockResolvedValue(null);
  // Default the start-of-book auto-download OFF so the many startBook() calls below don't
  // fire the real downloads pipeline; the dedicated describe opts each of its cases in.
  useSettings.setState({ autoDownloadNext: 'never' });
  // Reset the public store state between tests (module-level service/timer are
  // singletons; resetting nowPlaying + snapshot is enough to isolate behaviour).
  usePlayer.setState({ nowPlaying: null, snapshot: { ...INITIAL }, rate: 1 });
  // Clear the downloads registry (a shared singleton) so a leftover entry from the
  // hot-swap test can't affect another test's download lookup. nowPlaying is already
  // null above, so the store's useDownloads.subscribe hot-swap listener no-ops here.
  useDownloads.setState({ entries: {} });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// --- persist() (reached via the engine stop transition) --------------------

it('finding 12: initializing playback creates the shared service without loading or playing', async () => {
  await initializePlayback();
  expect(mockSvc.setup).toHaveBeenCalledTimes(1);
  expect(mockSvc.load).not.toHaveBeenCalled();
  expect(mockSvc.play).not.toHaveBeenCalled();
  expect(usePlayer.getState().nowPlaying).toBeNull();
});

describe('persist (via the engine snapshot transition)', () => {
  it('does NOT save when the whole-book position is <= 0', async () => {
    await startBook(makeBook(), 0);
    mockSaveProgress.mockClear();

    // playing → paused at position 0. persist() runs but bails on position <= 0.
    pushSnapshot(snap('playing', 0));
    pushSnapshot(snap('paused', 0));
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSaveProgress).not.toHaveBeenCalled();
  });

  it('saves with finished=false mid-book and finished=true within 5s of the end', async () => {
    await startBook(makeBook(), 0);

    // Mid-book pause: position 40 of 100 → finished false.
    mockSaveProgress.mockClear();
    pushSnapshot(snap('playing', 40));
    pushSnapshot(snap('paused', 40));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ position: 40, finished: false });

    // Near-end pause: position 96 of 100 (within FINISHED_TOLERANCE=5) → finished true.
    mockSaveProgress.mockClear();
    pushSnapshot(snap('playing', 96));
    pushSnapshot(snap('paused', 96));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ position: 96, finished: true });
  });

  it('invalidates the progress lists AND the played book own progress key on halt', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 40));
    (queryClient.invalidateQueries as jest.Mock).mockClear();

    pushSnapshot(snap('paused', 40));
    await flushMicrotasks();

    // The lists refresh AND the book screen's own `useBookProgress` entry, so a book
    // screen mounted beside the player (wide layout) doesn't go stale.
    expect(invalidatedKeys()).toContainEqual(qk.allProgress('c1'));
    expect(invalidatedKeys()).toContainEqual(qk.progress('c1', 2, 'A/Book.m4b'));
  });
});

// --- save loop start / stop (the leaked-interval fix) ----------------------

describe('save loop lifecycle', () => {
  it('runs the periodic save only while playing', async () => {
    await startBook(makeBook(), 0);

    // Enter playing → the 15s save loop starts.
    pushSnapshot(snap('playing', 10));
    await Promise.resolve();

    mockSaveProgress.mockClear();
    jest.advanceTimersByTime(15_000); // one save tick
    await Promise.resolve();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
  });

  it("stops the save loop and runs a final persist on playing -> 'error' (leaked-interval fix)", async () => {
    await startBook(makeBook(), 0);

    pushSnapshot(snap('playing', 50));
    await Promise.resolve();

    // The terminal 'error' state (web engine on a dead stream) must capture position
    // and halt the loop - exactly like pause/ended.
    mockSaveProgress.mockClear();
    pushSnapshot(snap('error', 50));
    await Promise.resolve();
    await Promise.resolve();

    // Final persist ran once on the transition...
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ position: 50 });

    // ...and the interval is stopped: advancing time triggers no further saves.
    mockSaveProgress.mockClear();
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(mockSaveProgress).not.toHaveBeenCalled();
  });

  it("also stops + persists on playing -> 'paused' and playing -> 'ended'", async () => {
    for (const terminal of ['paused', 'ended'] as const) {
      usePlayer.setState({ nowPlaying: null, snapshot: { ...INITIAL }, rate: 1 });
      await startBook(makeBook(), 0);
      pushSnapshot(snap('playing', 30));
      await Promise.resolve();

      mockSaveProgress.mockClear();
      pushSnapshot(snap(terminal, 30));
      await Promise.resolve();
      await Promise.resolve();
      expect(mockSaveProgress).toHaveBeenCalledTimes(1);

      // No further ticks after stopping.
      mockSaveProgress.mockClear();
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
      expect(mockSaveProgress).not.toHaveBeenCalled();
    }
  });

  it('keeps the save loop running through a brief buffer that recovers before the grace', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 20));
    await Promise.resolve();

    // Buffering: 'loading' arms the stall watchdog but must not stop the save loop.
    pushSnapshot(snap('loading', 20));
    await Promise.resolve();
    // Recover well before the stall grace (3s) elapses → no error, loop intact.
    jest.advanceTimersByTime(2_000);
    pushSnapshot(snap('playing', 21));
    await Promise.resolve();

    mockSaveProgress.mockClear();
    jest.advanceTimersByTime(15_000);
    await Promise.resolve();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState().snapshot.state).toBe('playing');
  });
});

// --- the periodic save driven by the engine's ticks ------------------------
// Android pauses every JS timer while the activity is paused (screen off, another app in
// front), so the 15 s interval never fires there; the engine's progress ticks still
// arrive. `inBackground` moves the clock without running a single timer and pushes one
// tick a second, which is exactly what JS sees in that state.

describe('the periodic save while JS timers are paused (Android in the background)', () => {
  /** `seconds` of engine ticks, one a second, from `from` on, with no timer firing. */
  function inBackground(seconds: number, from: number, state: PlaybackState = 'playing') {
    for (let i = 1; i <= seconds; i++) {
      jest.setSystemTime(Date.now() + 1_000);
      pushSnapshot(snap(state, from + i));
    }
  }

  /** A book started and playing at `at`, with nothing saved yet. */
  async function startPlaying(at = 10) {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', at));
    mockSaveProgress.mockClear();
  }

  it("saves every 15 s of playing from the engine's ticks, and stops on a pause", async () => {
    await startPlaying();
    inBackground(45, 10);
    await flushMicrotasks();
    expect(savedPositions()).toEqual([25, 40, 55]);

    // A pause (the notification shade) saves once; a paused engine's ticks never do.
    mockSaveProgress.mockClear();
    pushSnapshot(snap('paused', 55));
    inBackground(45, 55, 'paused');
    await flushMicrotasks();
    expect(savedPositions()).toEqual([55]);
  });

  it('never saves twice in one interval when the interval and the ticks both run', async () => {
    await startPlaying();
    // In front: the interval fires AND the ticks arrive, offset so a tick lands just
    // before each of the interval's turns.
    jest.advanceTimersByTime(500);
    for (let i = 1; i <= 45; i++) {
      jest.advanceTimersByTime(1_000);
      pushSnapshot(snap('playing', 10 + i));
    }
    await flushMicrotasks();
    expect(savedPositions()).toHaveLength(3);

    // Sent to the background mid-interval: the ticks carry on where the interval left off.
    mockSaveProgress.mockClear();
    inBackground(30, 55);
    await flushMicrotasks();
    expect(savedPositions()).toHaveLength(2);
  });

  it("holds the ticks' saves while a place check is out, then carries on", async () => {
    await startPlaying();
    inBackground(12, 10);
    const release = holdSaves();
    inBackground(4, 22); // the save due at 15 s falls inside the hold
    await flushMicrotasks();
    expect(mockSaveProgress).not.toHaveBeenCalled();
    release({ flush: false }); // the check answered (a fetch resolves in the background)
    inBackground(15, 26);
    await flushMicrotasks();
    // The held turn still took its turn, as the interval's would: the next is 15 s on.
    expect(savedPositions()).toEqual([40]);
  });

  it('ends a hold whose 5 s release timer never fired, and saves', async () => {
    await startPlaying();
    holdSaves(); // the check's answer never comes, and its 5 s timer is paused too
    inBackground(15, 10);
    await flushMicrotasks();
    expect(savedPositions()).toEqual([25]);
  });

  it("saves a seek at once and keeps the periodic save's own cadence", async () => {
    await startPlaying(40);
    inBackground(5, 40);
    // A seek back from the notification: saved straight away (the floor comes down with
    // it), and the next periodic save is still due 15 s after the loop started, not 15 s
    // after the seek.
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(async (p: number) =>
      pushSnapshot(snap('playing', p)),
    );
    await usePlayer.getState().seekBook(10);
    await flushMicrotasks();
    expect(savedPositions()).toEqual([10]);
    inBackground(10, 10);
    await flushMicrotasks();
    expect(savedPositions()).toEqual([10, 20]);
  });
});

// --- stall watchdog (a 'loading' that never resolves becomes an 'error') ----
// Moved out of the iOS native module into shared JS so iOS/Android/web behave the
// same off the `loading` signal every engine emits.

describe('stall watchdog promotes a stuck loading to error', () => {
  it('a seek that lands once the watchdog surfaced the error is the place shown', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    // The seek waits on the stalled stream past the grace.
    let take: () => void = () => undefined;
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (take = resolve)),
    );
    const seek = usePlayer.getState().seekInTrack(80);
    await flushMicrotasks();
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    take();
    await seek;
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 80 });
    await usePlayer.getState().retry();
    expect(((mockSvc.load as jest.Mock).mock.lastCall as unknown[]).slice(1, 3)).toEqual([0, 80]);
  });

  it('a seek on a book in error rebuilds the engine at the place, never seeks its dead item', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    (mockSvc.seekTo as jest.Mock).mockClear();
    await usePlayer.getState().seekInTrack(80);
    expect(mockSvc.skipToTrack).toHaveBeenLastCalledWith(0, 80);
    expect(mockSvc.seekTo).not.toHaveBeenCalled();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 80 });
  });

  it("synthesizes 'error' when 'loading' outlasts the grace, halting the save loop", async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();

    // Stream stalls: the engine sits in 'loading'. After the 3s grace with no
    // recovery the watchdog surfaces an 'error' so the UI can offer a retry.
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();

    mockSaveProgress.mockClear();
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(usePlayer.getState().snapshot.state).toBe('error');
    // Final persist captured the position where it stalled...
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ position: 50 });

    // ...and the save loop is halted (no further ticks).
    mockSaveProgress.mockClear();
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(mockSaveProgress).not.toHaveBeenCalled();
  });

  // fe#158: Android pauses JS timers with the screen off, but the engine's events still
  // arrive; the deadline is checked on them.
  it('fires from an engine event once the grace passed while the JS timer could not', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    // The clock moves, the timer does not run.
    jest.setSystemTime(Date.now() + 2_000);
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('loading'); // inside the grace
    jest.setSystemTime(Date.now() + 1_500);
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');
  });

  it('does not error if playback recovers within the grace', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 30));
    await Promise.resolve();
    pushSnapshot(snap('loading', 30));
    await Promise.resolve();

    jest.advanceTimersByTime(2_000);
    pushSnapshot(snap('playing', 31));
    await Promise.resolve();

    jest.advanceTimersByTime(5_000); // well past the original grace
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('playing');
  });

  it('reads a parked loading as paused while there is no playback intent', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 30));
    await Promise.resolve();
    // User pauses, then the engine reports buffering while parked (e.g. ExoPlayer
    // STATE_BUFFERING with playWhenReady=false, or iOS reporting a failed item as
    // `loading` while paused). With no intent to play, a `loading` is read as
    // `paused` - the play button stays usable instead of stranding an endless
    // spinner with no watchdog - and it is never promoted to an error.
    pushSnapshot(snap('paused', 30));
    await Promise.resolve();
    pushSnapshot(snap('loading', 30));
    await Promise.resolve();

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('paused');
  });

  it("shows a spinner for 'ready' while intending to play, and still errors if it never plays", async () => {
    await startBook(makeBook(), 0); // playBook sets wantsPlayback = true
    // The engine reports the track loaded-but-not-yet-playing. Because we intend to
    // play, this must surface as 'loading' (spinner) and arm the watchdog - not strand
    // the UI at an idle play button (the cause of the "press play, nothing happens"
    // two-press bug: retry's load() emitted 'ready' which landed as the final state).
    pushSnapshot(snap('ready', 50));
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('loading');

    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');
  });

  it('treats a transient paused during the start window as loading (not a real pause)', async () => {
    await startBook(makeBook(), 0); // startingPlayback = true, wantsPlayback = true
    // The native bridge emits a spurious 'paused' while rebuilding the queue on start.
    // Because we're still connecting, it must read as a spinner and keep the watchdog -
    // not clear our intent and strand the UI (the actual device bug: the spinner showed
    // but never armed the watchdog, so it spun forever).
    pushSnapshot(snap('paused', 50));
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('loading');

    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');
  });

  it('keeps a real pause (after playback started) as paused - no spinner, no error', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 30)); // reaching 'playing' ends the start window
    await Promise.resolve();
    pushSnapshot(snap('paused', 30)); // genuine user/lock-screen pause
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('paused');

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('paused');
  });

  it('holds the error against the engine still re-reporting the stall', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');

    // The engine keeps re-reporting around the dead stream and NONE of it (with no
    // retry in flight) may downgrade the surfaced error: iOS frozen 'loading' ticks,
    // and Android's onPlayerError → STATE_IDLE ('idle') + a stray 'paused'. This is the
    // flash→spinner loop seen on the Android device.
    for (const s of ['loading', 'idle', 'paused', 'loading', 'ended'] as const) {
      pushSnapshot(snap(s, 50));
      await Promise.resolve();
      expect(usePlayer.getState().snapshot.state).toBe('error');
    }

    // No fresh watchdog was armed by the held re-reports, so nothing flips later either.
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');
  });

  // The device run (fe#158): the stop said "Playback stopped" while the engine went on
  // buffering, and it started by itself once the server answered again.
  it('stops the engine when it fires, so nothing plays without a press', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    jest.mocked(mockSvc.pause).mockClear();
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    expect(mockSvc.pause).toHaveBeenCalledTimes(1);
    // The engine's report of that pause is held by the error.
    pushSnapshot(snap('paused', 50));
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');
  });

  it('never stops the engine for an attempt that played in time', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    jest.mocked(mockSvc.pause).mockClear();
    pushSnapshot(snap('playing', 51));
    await Promise.resolve();
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  it('lets a play from outside the app (playing) clear the error', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');

    // The lock screen or the car plays the paused engine → it reports 'playing', which is
    // not a stall re-report, so it clears the error. (A moment after the stop: one reported
    // at once may be from before its pause, below.)
    jest.advanceTimersByTime(1_000);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('playing');
  });

  /** Started, then stalled into the watchdog's error, the engine paused by it. */
  async function stalledIntoError() {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    jest.mocked(mockSvc.pause).mockClear();
  }

  // The review (fe#157): a car or headset play after the error was held by it, so it could
  // hang with nothing said, or start whenever the server answered.
  it('follows a play asked from outside the app after the error like a press', async () => {
    await stalledIntoError();
    jest.advanceTimersByTime(1_000);
    playAsked?.();
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('loading');
    // It never plays: the same stop, the engine paused again.
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    expect(mockSvc.pause).toHaveBeenCalledTimes(1);
  });

  it('a play asked from outside that plays in time just plays', async () => {
    await stalledIntoError();
    playAsked?.();
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('playing');
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  it('a play the engine was asked for outside an error adds no watchdog of its own', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    await usePlayer.getState().pause();
    pushSnapshot(snap('paused', 50));
    await Promise.resolve();
    jest.mocked(mockSvc.pause).mockClear();
    playAsked?.();
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('paused');
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  // The review: the engine's `playing` sent just before the watchdog's pause reached it read
  // as a recovery, and "Playback stopped" was gone.
  it("a playing reported just after the watchdog's pause is older than it: the pause wins", async () => {
    await stalledIntoError();
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    expect(mockSvc.pause).toHaveBeenCalledTimes(1);
    // A press of the listener's own plays at once.
    await usePlayer.getState().retry();
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('playing');
  });

  // The review: iOS says nothing of a play asked from outside, so a car or headset play right
  // after the stop was paused again as an older report. Once the engine reports the pause, a
  // `playing` is a new play.
  it('a playing after the engine reported the pause is a play from outside (iOS)', async () => {
    await stalledIntoError();
    pushSnapshot(snap('paused', 50));
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('playing');
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  // The review: Android's pause of a buffering engine reads `loading`, so the fence held a
  // car or headset play the engine did not tell of for its whole second. The engine says it
  // stopped wanting to play: a `playing` from there is a new play.
  it("a playing after Android's engine stopped wanting to play is a new play", async () => {
    await stalledIntoError();
    pushSnapshot(snap('loading', 50));
    pauseAsked?.();
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('playing');
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  it('re-arms after a retry that also stalls', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 40));
    await Promise.resolve();
    pushSnapshot(snap('loading', 40));
    await Promise.resolve();
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');

    // Retry reloads + plays; the engine buffers again, and a second grace elapses
    // with no recovery → error again (the watchdog re-armed for the new attempt).
    await usePlayer.getState().retry();
    pushSnapshot(snap('loading', 40));
    await Promise.resolve();
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');
  });
});

// --- clampRate (reached via setRate) ---------------------------------------

describe('a browser autoplay refusal reads as a plain pause', () => {
  const blockNextPlay = () =>
    (mockSvc.play as jest.Mock).mockRejectedValueOnce(new AutoplayBlockedError());

  async function expectSettledPaused() {
    expect(usePlayer.getState().snapshot.state).toBe('paused');
    // The engine keeps re-reporting its parked element: still a pause, never a spinner.
    pushSnapshot(snap('loading', 0));
    await Promise.resolve();
    // Well past the stall grace: the watchdog was disarmed, so no synthesized error.
    jest.advanceTimersByTime(10_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('paused');
  }

  it('playBook (a cold deep link) resolves with the book loaded and paused', async () => {
    blockNextPlay();
    await expect(startBook(makeBook(), 0)).resolves.toBeUndefined();
    expect(usePlayer.getState().nowPlaying?.path).toBe('A/Book.m4b');
    await expectSettledPaused();
  });

  it('toggle settles to paused too', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 10));
    await Promise.resolve();
    pushSnapshot(snap('paused', 10));
    await Promise.resolve();
    blockNextPlay();
    await expect(usePlayer.getState().toggle()).resolves.toBeUndefined();
    await expectSettledPaused();
  });

  it('retry settles to paused too', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 42));
    await Promise.resolve();
    pushSnapshot(snap('error', 42));
    await Promise.resolve();
    blockNextPlay();
    await expect(usePlayer.getState().retry()).resolves.toBeUndefined();
    await expectSettledPaused();
  });

  it('any other play() failure still propagates and the watchdog still errors', async () => {
    const cause = new Error('decode failed');
    (mockSvc.play as jest.Mock).mockRejectedValueOnce(cause);
    const started = startBook(makeBook(), 0);
    await expect(started).rejects.toBeInstanceOf(PlaybackStartError);
    await expect(started).rejects.toMatchObject({ reason: 'unknown', connectionId: 'c1', cause });
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('error');
  });
});

describe('a failed start says why (PlaybackStartError)', () => {
  afterEach(() => useReachability.setState({ online: {} }));

  it("passes the engine's reason on: the audio didn't load", async () => {
    (mockSvc.play as jest.Mock).mockRejectedValueOnce(new PlaybackStartError('audio'));
    await expect(startBook(makeBook(), 0)).rejects.toMatchObject({
      name: 'PlaybackStartError',
      reason: 'audio',
      connectionId: 'c1',
    });
  });

  it("is offline when the book's server is known to be unreachable, whatever the engine said", async () => {
    useReachability.setState({ online: { c1: false } });
    (mockSvc.play as jest.Mock).mockRejectedValueOnce(new PlaybackStartError('audio'));
    await expect(startBook(makeBook(), 0)).rejects.toMatchObject({
      reason: 'offline',
      connectionId: 'c1',
    });
  });

  it("keeps the engine's reason for a downloaded book: it needs no server", async () => {
    const manifest: DownloadManifest = {
      book: makeBook(),
      chapters: null,
      files: [{ relPath: 'A/Book.m4b', localUri: 'file:///dl/0.m4b' }],
      coverUri: null,
      savedAt: '2026-01-01T00:00:00Z',
    };
    const entry: DownloadEntry = {
      connectionId: 'c1',
      libraryId: 2,
      path: 'A/Book.m4b',
      title: 'A Book',
      status: 'downloaded',
      progress: 1,
      bytes: 0,
      totalBytes: 0,
      manifest,
    };
    useDownloads.setState({ entries: { 'c1:2:A/Book.m4b': entry } });
    useReachability.setState({ online: { c1: false } });
    (mockSvc.play as jest.Mock).mockRejectedValueOnce(new PlaybackStartError('audio'));
    await expect(startBook(makeBook(), 0)).rejects.toMatchObject({ reason: 'audio' });
  });

  it('retry never rejects after a failed resume lookup, though the start fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockLoadInitialProgress.mockResolvedValueOnce({ kind: 'failed' });
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined);
    expect(usePlayer.getState().snapshot.state).toBe('error');
    mockLoadInitialProgress.mockResolvedValueOnce({ kind: 'empty' });
    (mockSvc.play as jest.Mock).mockRejectedValueOnce(new PlaybackStartError('audio'));
    await expect(usePlayer.getState().retry()).resolves.toBeUndefined();
    expect(mockLoadInitialProgress).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[player] could not start playback', expect.anything());
    warn.mockRestore();
  });

  it('toggle and retry never reject: the error state shows Retry', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await startBook(makeBook(), 0);
    pushSnapshot(snap('error', 42));
    await Promise.resolve();
    (mockSvc.play as jest.Mock).mockRejectedValueOnce(new PlaybackStartError('audio'));
    await expect(usePlayer.getState().toggle()).resolves.toBeUndefined();
    (mockSvc.play as jest.Mock).mockRejectedValueOnce(new Error('no supported sources'));
    await expect(usePlayer.getState().retry()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('setRate clamps the playback rate to [0.5, 2]', () => {
  it('caps above 2x', async () => {
    await usePlayer.getState().setRate(5);
    expect(usePlayer.getState().rate).toBe(2);
  });

  it('floors below 0.5x', async () => {
    await usePlayer.getState().setRate(0.1);
    expect(usePlayer.getState().rate).toBe(0.5);
  });

  it('passes a normal rate through unchanged', async () => {
    await usePlayer.getState().setRate(1.5);
    expect(usePlayer.getState().rate).toBe(1.5);
  });
});

// --- retry() (recovery after an 'error' state) -----------------------------

describe('retry rebuilds the engine from the current spot', () => {
  it('re-loads the current track + position and resumes', async () => {
    await startBook(makeBook(), 0);
    // Simulate playing, then a dead stream reported by the engine.
    pushSnapshot(snap('playing', 42));
    await Promise.resolve();
    pushSnapshot(snap('error', 42));
    await Promise.resolve();

    (mockSvc.load as jest.Mock).mockClear();
    (mockSvc.play as jest.Mock).mockClear();
    await usePlayer.getState().retry();

    // load() is re-issued with the current trackIndex (0) and position (42) so the
    // failed AVPlayerItem is re-created and the stream re-requested, then play().
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    expect((mockSvc.load as jest.Mock).mock.calls[0][1]).toBe(0); // startIndex
    expect((mockSvc.load as jest.Mock).mock.calls[0][2]).toBe(42); // positionInTrack
    expect(mockSvc.play).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing is playing', async () => {
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().retry();
    expect(mockSvc.load).not.toHaveBeenCalled();
  });

  it('loads nothing when the book was stopped while the Retry was out', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('error', 42));
    await Promise.resolve();
    (mockSvc.load as jest.Mock).mockClear();
    const retrying = usePlayer.getState().retry();
    // The stop's last step, landing while the Retry waits on the engine.
    usePlayer.setState({ nowPlaying: null });
    await retrying;
    expect(mockSvc.load).not.toHaveBeenCalled();
  });
});

// --- resume safety: never silently restart an in-progress book from 0 ---------

describe('resume never restarts an in-progress book from 0', () => {
  it('resumes from saved progress (and speed) instead of 0', async () => {
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'progress',
      progress: makeProgress({ position: 30, playback_speed: 1.5 }),
    });
    (mockSvc.load as jest.Mock).mockClear();
    // No explicit start position → the resume lookup drives the start point.
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined);
    expect((mockSvc.load as jest.Mock).mock.calls[0][1]).toBe(0); // startIndex (single file)
    expect((mockSvc.load as jest.Mock).mock.calls[0][2]).toBe(30); // positionInTrack
    expect(usePlayer.getState().rate).toBe(1.5);
  });

  it('restarts a FINISHED book from 0 (re-listen) and does not block early low-position saves', async () => {
    // finishBook saves the finished position at the whole-book end (position ~= duration).
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'progress',
      progress: makeProgress({ finished: true, position: 100, duration: 100 }),
    });
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined);

    // The saved end position is ignored: a re-listen starts at 0, not near the end (which
    // would instantly re-fire the end-of-book flow).
    expect((mockSvc.load as jest.Mock).mock.calls[0][1]).toBe(0); // startIndex (single file)
    expect((mockSvc.load as jest.Mock).mock.calls[0][2]).toBe(0); // positionInTrack

    // resumeFloor is 0 for the fresh session, so an early low-position save is NOT blocked
    // by the slip guard.
    mockSaveProgress.mockClear();
    pushSnapshot(snap('playing', 3));
    pushSnapshot(snap('paused', 3));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ position: 3, finished: false });
  });

  it('restarts a book marked finished mid-book from 0 (the finished flag is the done signal)', async () => {
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'progress',
      progress: makeProgress({ finished: true, position: 40, duration: 100 }),
    });
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined);
    // Even with a mid-book saved position, a finished book restarts from 0.
    expect((mockSvc.load as jest.Mock).mock.calls[0][2]).toBe(0); // positionInTrack
  });

  it('leaves UNFINISHED mid-book resume unchanged (starts at the saved position)', async () => {
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'progress',
      progress: makeProgress({ finished: false, position: 40, duration: 100 }),
    });
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined);
    expect((mockSvc.load as jest.Mock).mock.calls[0][2]).toBe(40); // positionInTrack
  });

  it('fails safe (error, no playback) when a streaming resume lookup fails', async () => {
    mockLoadInitialProgress.mockResolvedValueOnce({ kind: 'failed' });
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined);
    // Must NOT restart at 0: surface an error and load nothing.
    expect(usePlayer.getState().snapshot.state).toBe('error');
    expect(mockSvc.load).not.toHaveBeenCalled();
  });

  it('switching from a playing book to a failed-resume book stops the old book and saves nothing under the new path', async () => {
    // Book A is playing with its save loop running.
    await startBook(makeBook({ rel_path: 'A/BookA.m4b' }), 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();

    (mockSvc.reset as jest.Mock).mockClear();
    // Switch to book B, whose streaming resume lookup fails.
    mockLoadInitialProgress.mockResolvedValueOnce({ kind: 'failed' });
    await usePlayer.getState().playBook('c1', 2, makeBook({ rel_path: 'B/BookB.m4b' }), undefined);

    // The previous book's engine is torn down and the UI shows B in error.
    expect(mockSvc.reset).toHaveBeenCalled();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    expect(usePlayer.getState().nowPlaying?.path).toBe('B/BookB.m4b');

    // The old save loop is stopped, so a 15s tick must not persist A's position under
    // B's path (the corruption this fix prevents).
    mockSaveProgress.mockClear();
    jest.advanceTimersByTime(15_000);
    await Promise.resolve();
    expect(mockSaveProgress).not.toHaveBeenCalled();
  });

  it('retry re-runs the resume lookup after a streaming resume failure', async () => {
    mockLoadInitialProgress.mockResolvedValueOnce({ kind: 'failed' });
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined);
    expect(usePlayer.getState().snapshot.state).toBe('error');

    // The server recovers → retry re-fetches and resumes at the real position.
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'progress',
      progress: makeProgress({ position: 55 }),
    });
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().retry();
    expect(mockLoadInitialProgress).toHaveBeenCalledTimes(2);
    expect((mockSvc.load as jest.Mock).mock.calls[0][2]).toBe(55); // positionInTrack
  });

  it('save guard: a position far below the resume floor is not persisted', async () => {
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'progress',
      progress: makeProgress({ position: 300, duration: 1000 }),
    });
    await usePlayer.getState().playBook('c1', 2, makeBook({ duration: 1000 }), undefined);

    // A spurious restart reports position 2 (≪ resumeFloor 300) → must not overwrite.
    mockSaveProgress.mockClear();
    pushSnapshot(snap('playing', 2, { duration: 1000 }));
    pushSnapshot(snap('paused', 2, { duration: 1000 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSaveProgress).not.toHaveBeenCalled();
  });

  it('save guard: a low position IS persisted after a deliberate backward seek', async () => {
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'progress',
      progress: makeProgress({ position: 300, duration: 1000 }),
    });
    await usePlayer.getState().playBook('c1', 2, makeBook({ duration: 1000 }), undefined);

    // The user deliberately seeks back to 2 → the floor lowers, so saving is allowed.
    await usePlayer.getState().seekBook(2);
    mockSaveProgress.mockClear();
    pushSnapshot(snap('playing', 2, { duration: 1000 }));
    pushSnapshot(snap('paused', 2, { duration: 1000 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSaveProgress).toHaveBeenCalled();
  });
});

describe('the speed a book starts at', () => {
  const mirror = (playback_speed: number, updated_at: string) => ({
    connectionId: 'c1',
    libraryId: 2,
    path: 'A/Book.m4b',
    position: 40,
    duration: 100,
    finished: false,
    playback_speed,
    device_id: 'dev-1',
    updated_at,
  });

  it("at an explicit place, is the book's saved speed, not the default", async () => {
    useSettings.setState({ defaultRate: 1 });
    mockReadMirror.mockResolvedValueOnce(mirror(1.4, '2026-10-01T00:00:00Z'));
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 30); // a chapter tap
    expect(usePlayer.getState().rate).toBe(1.4);
    expect((mockSvc.setRate as jest.Mock).mock.calls).toEqual([[1.4]]);
    // The resume lookup (a network round trip) is still skipped.
    expect(mockLoadInitialProgress).not.toHaveBeenCalled();
  });

  it('takes the newer of the cached server progress and the local mirror', async () => {
    mockReadMirror.mockResolvedValueOnce(mirror(1.4, '2026-10-01T00:00:00Z'));
    (queryClient.getQueryData as jest.Mock).mockReturnValueOnce(
      makeProgress({ playback_speed: 1.8, updated_at: '2026-10-02T00:00:00Z' }),
    );
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 30);
    expect(usePlayer.getState().rate).toBe(1.8);
  });

  // The cached place is the server's row, stamped by its server's clock; the mirror's record
  // a capture of this device's. Which is newer is the mirror's own rule (`mirrorIsNewest`,
  // by one clock), never the two stamps as they are (fe#259).
  it("takes this device's later record over a row stamped by a server whose clock is ahead", async () => {
    const mine = mirror(1.4, '2026-10-01T00:00:30Z');
    // 90 s ahead: the row was written at 00:00:00 here.
    const row = makeProgress({ playback_speed: 1.8, updated_at: '2026-10-01T00:01:30Z' });
    mockReadMirror.mockResolvedValueOnce(mine);
    (queryClient.getQueryData as jest.Mock).mockReturnValueOnce(row);
    mockMirrorIsNewest.mockResolvedValueOnce(true);
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 30);
    expect(mockMirrorIsNewest).toHaveBeenLastCalledWith(mine, row);
    expect(usePlayer.getState().rate).toBe(1.4);
  });

  // Decision 7 regression (8b-1, D3): the one change here is the default a book with no
  // speed of its own starts at (`listenerSettings`): 1x for a kids profile.
  describe('in kids mode', () => {
    beforeEach(() =>
      useProfiles.setState({
        hydrated: true,
        activeProfileId: 'evie',
        profiles: [{ id: 'evie', name: 'Evie', connectionIds: ['c1'], kids: { bedtime: '19:30' } }],
      }),
    );
    afterEach(() => {
      resetProfilesForTests();
      useSettings.setState({ defaultRate: 1 });
    });

    it("starts a story at 1x, never the grown-up's default speed", async () => {
      useSettings.setState({ defaultRate: 1.4 });
      mockLoadInitialProgress.mockResolvedValueOnce({ kind: 'empty' });
      await usePlayer.getState().playBook('c1', 2, makeBook());
      expect(usePlayer.getState().rate).toBe(1);
      expect((mockSvc.setRate as jest.Mock).mock.calls).toEqual([[1]]);
    });

    it('keeps a speed saved for the kid on that story', async () => {
      useSettings.setState({ defaultRate: 1.4 });
      mockLoadInitialProgress.mockResolvedValueOnce({
        kind: 'progress',
        progress: makeProgress({ position: 30, playback_speed: 1.2 }),
      });
      await usePlayer.getState().playBook('c1', 2, makeBook());
      expect(usePlayer.getState().rate).toBe(1.2);
    });

    it('a grown-up still starts at their default speed', async () => {
      useProfiles.setState({
        profiles: [{ id: 'evie', name: 'Evie', connectionIds: ['c1'] }],
      });
      useSettings.setState({ defaultRate: 1.4 });
      mockLoadInitialProgress.mockResolvedValueOnce({ kind: 'empty' });
      await usePlayer.getState().playBook('c1', 2, makeBook());
      expect(usePlayer.getState().rate).toBe(1.4);
    });
  });

  it('is the asked-for speed, set before the engine starts, over a saved one', async () => {
    mockReadMirror.mockResolvedValue(mirror(1.4, '2026-10-01T00:00:00Z'));
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'progress',
      progress: makeProgress({ position: 30, playback_speed: 1.4 }),
    });
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 30, undefined, 1.25);
    expect((mockSvc.setRate as jest.Mock).mock.calls).toEqual([[1.25]]);
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, undefined, undefined, 1.25);
    expect(usePlayer.getState().rate).toBe(1.25);
  });
});

describe('a seek from the OS media controls (web Media Session)', () => {
  it('lowers the resume floor and saves, like a seek in the app', async () => {
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'progress',
      progress: makeProgress({ position: 300, duration: 1000 }),
    });
    await usePlayer.getState().playBook('c1', 2, makeBook({ duration: 1000 }), undefined);
    pushSnapshot(snap('playing', 300, { duration: 1000 }));
    // Both engines report the new position as soon as they seek.
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(async (p: number) =>
      pushSnapshot(snap('playing', p, { duration: 1000 })),
    );
    mockSaveProgress.mockClear();

    // The lock screen's scrubber, dragged back from 300 to 20.
    expect(remoteSeek).not.toBeNull();
    remoteSeek!(20);
    await flushMicrotasks();
    expect(mockSvc.seekTo).toHaveBeenCalledWith(20);
    pushSnapshot(snap('paused', 20, { duration: 1000 }));
    await flushMicrotasks();
    expect(mockSaveProgress).toHaveBeenCalled();
    expect(mockSaveProgress.mock.calls.at(-1)![1]).toMatchObject({ position: 20 });
  });
});

describe('stopPlaybackForConnection (the token-revoking teardown rule)', () => {
  it('stops playback when the playing book came from that connection', async () => {
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();

    (mockSvc.reset as jest.Mock).mockClear();
    // Matched by the stable connection id (nowPlaying.connectionId), so it works
    // regardless of ApiClient instances being rebuilt when the connection list changes.
    await stopPlaybackForConnection('c1');

    expect(mockSvc.reset).toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying).toBeNull();
  });

  it('teardownBeforeTokenRevoke stops playback and flushes the connection being revoked', async () => {
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();

    (mockSvc.reset as jest.Mock).mockClear();
    await teardownBeforeTokenRevoke('c1');

    expect(mockSvc.reset).toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying).toBeNull();
    // Flushes THIS connection specifically (unlike flushQueue, it doesn't skip on the
    // connection's reachability), so its queued saves land before removal purges them.
    expect(flushConnection).toHaveBeenCalledWith('c1');
    // And gives the bookmarks waiting on the device their last send.
    expect(mockSendBookmarks).toHaveBeenCalledWith('c1');
  });

  // Web: a tab playing through the connection sends its own while the token still works,
  // so this tab flushes only once the other tabs are done (their wait runs beside its stop).
  it('teardownBeforeTokenRevoke flushes only once its stop and the other tabs are done', async () => {
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    (flushConnection as jest.Mock).mockClear();
    let othersDone: () => void = () => {};
    const told = jest
      .spyOn(session, 'tellOtherTabsGoing')
      .mockImplementation(() => new Promise<void>((r) => (othersDone = r)));
    try {
      const teardown = teardownBeforeTokenRevoke('c1');
      await flushMicrotasks(20);
      expect(usePlayer.getState().nowPlaying).toBeNull();
      expect(told).toHaveBeenCalledWith('c1');
      expect(flushConnection).not.toHaveBeenCalled();
      othersDone();
      await teardown;
      expect(flushConnection).toHaveBeenCalledWith('c1');
    } finally {
      told.mockRestore();
    }
  });

  it('leaves a book from another connection playing (its token stays valid)', async () => {
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();

    (mockSvc.reset as jest.Mock).mockClear();
    await stopPlaybackForConnection('c2');

    expect(mockSvc.reset).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying).not.toBeNull();
  });
});

// --- a re-pair while a book plays, and stops that overlap --------------------

describe("the connection's client at each save", () => {
  afterEach(() => mockResolveClient.mockImplementation(() => fakeClient));

  it('saves and posts the listening through the client of a re-pair made while the book plays', async () => {
    await startBook(makeBook(), 0, 'c1');
    pushSnapshot(snap('playing', 40));
    // A re-pair: the connection is the same, its token (and so its client) another.
    const repaired = { ...fakeClient, addHistory: jest.fn(async () => {}) };
    mockResolveClient.mockImplementation(() => repaired);
    mockSaveProgress.mockClear();
    mockLiveClient.mockClear();
    (fakeClient.addHistory as jest.Mock).mockClear();
    jest.advanceTimersByTime(45_000);
    pushSnapshot(snap('paused', 85));
    await flushMicrotasks();
    expect(mockSaveProgress).toHaveBeenCalledWith(
      repaired,
      expect.objectContaining({ connectionId: 'c1', position: 85 }),
    );
    expect(mockSaveProgress).not.toHaveBeenCalledWith(fakeClient, expect.anything());
    // Through the client read again at each send (`liveClient`), not one taken up front:
    // `saveProgress` sends only after awaits of its own (the mirror, a guard's check).
    expect(mockLiveClient).toHaveBeenCalledWith('c1');
    expect(repaired.addHistory).toHaveBeenCalled();
    expect(fakeClient.addHistory).not.toHaveBeenCalled();
  });
});

describe('stops of one book that overlap', () => {
  it('save its place once (a tab told the connection is going, then that it is gone)', async () => {
    await startBook(makeBook(), 0, 'c1');
    pushSnapshot(snap('playing', 40));
    await flushMicrotasks();
    mockSaveProgress.mockClear();
    let saved: () => void = () => {};
    mockSaveProgress.mockImplementationOnce(
      () => new Promise<void>((resolve) => (saved = () => resolve())),
    );
    const going = usePlayer.getState().stop();
    await flushMicrotasks();
    const removed = usePlayer.getState().stop();
    await flushMicrotasks();
    saved();
    await Promise.all([going, removed]);
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState().nowPlaying).toBeNull();
  });

  it('saves again for a stop made once the first one has saved', async () => {
    await startBook(makeBook(), 0, 'c1');
    pushSnapshot(snap('playing', 40));
    await flushMicrotasks();
    mockSaveProgress.mockClear();
    await usePlayer.getState().stop();
    await startBook(makeBook(), 0, 'c1');
    pushSnapshot(snap('playing', 50));
    await flushMicrotasks();
    mockSaveProgress.mockClear();
    await usePlayer.getState().stop();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
  });

  it('saves its own place for a stop of the book started again while the first stop still saves', async () => {
    await startBook(makeBook(), 0, 'c1');
    pushSnapshot(snap('playing', 40));
    await flushMicrotasks();
    let saved: () => void = () => {};
    mockSaveProgress.mockImplementationOnce(
      () => new Promise<void>((resolve) => (saved = () => resolve())),
    );
    const first = usePlayer.getState().stop();
    await flushMicrotasks();
    // The same book again while that save is still out (a slow server), heard further on.
    await startBook(makeBook(), 0, 'c1');
    pushSnapshot(snap('playing', 70));
    await flushMicrotasks();
    mockSaveProgress.mockClear();
    const second = usePlayer.getState().stop();
    await flushMicrotasks();
    expect(mockSaveProgress).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ connectionId: 'c1', position: 70 }),
    );
    saved();
    await Promise.all([first, second]);
  });
});

describe('a stop whose save is still out when a start is made', () => {
  /** Start the book, playing at 40, and stop it with its save held; returns the release. */
  async function stopHeld(): Promise<{ stopping: Promise<void>; save: () => void }> {
    await startBook(makeBook(), 0, 'c1');
    pushSnapshot(snap('playing', 40));
    await flushMicrotasks();
    let save: () => void = () => {};
    mockSaveProgress.mockImplementationOnce(
      () => new Promise<void>((resolve) => (save = () => resolve())),
    );
    const stopping = usePlayer.getState().stop();
    await flushMicrotasks();
    return { stopping, save };
  }

  it('leaves the same book started again loaded when the save lands', async () => {
    const { stopping, save } = await stopHeld();
    await startBook(makeBook(), 0, 'c1');
    (mockSvc.reset as jest.Mock).mockClear();
    save();
    await stopping;
    expect(mockSvc.reset).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying).toMatchObject({ connectionId: 'c1' });
  });

  it('leaves a start of the same book that failed as it is: the listener asked for it after the stop', async () => {
    const { stopping, save } = await stopHeld();
    (mockSvc.load as jest.Mock).mockRejectedValueOnce(new Error('no source'));
    await expect(startBook(makeBook(), 0, 'c1')).rejects.toThrow('no source');
    (mockSvc.reset as jest.Mock).mockClear();
    save();
    await stopping;
    expect(mockSvc.reset).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying).toMatchObject({ connectionId: 'c1' });
  });

  it('still unloads the book when nothing was started meanwhile', async () => {
    const { stopping, save } = await stopHeld();
    save();
    await stopping;
    expect(mockSvc.reset).toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying).toBeNull();
  });
});

// --- per-connection scoping of saves + the download hot-swap -----------------

describe('connection scoping', () => {
  describe("finding 11: a switch to another server's book saves the previous book through its own server", () => {
    const client2 = {
      ...fakeClient,
      coverUrl: () => 'c2-cover',
      addHistory: jest.fn(async () => {}),
    };
    const playing = () => {
      pushSnapshot(snap('playing', 40));
    };
    /** A start on c2 whose resume lookup is still out (the window between the switch and
     * the new book becoming `nowPlaying`). */
    async function startOnOtherServer() {
      let resume!: (value: ResumeLookup) => void;
      mockLoadInitialProgress.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resume = resolve;
          }),
      );
      const starting = usePlayer
        .getState()
        .playBook('c2', 2, makeBook({ rel_path: 'B/Other.m4b' }));
      for (let i = 0; i < 40; i++) await Promise.resolve();
      return { resume, starting };
    }

    beforeEach(() => {
      mockResolveClient.mockImplementation((cid: string) =>
        cid === 'c2' ? (client2 as typeof fakeClient) : fakeClient,
      );
    });
    afterEach(() => mockResolveClient.mockImplementation(() => fakeClient));

    it("saves the previous book's place at the switch, through its own server", async () => {
      await startBook(makeBook(), 0, 'c1');
      playing();
      mockSaveProgress.mockClear();
      const { resume, starting } = await startOnOtherServer();
      expect(mockSaveProgress).toHaveBeenCalledWith(
        fakeClient,
        expect.objectContaining({ connectionId: 'c1', path: 'A/Book.m4b', position: 40 }),
      );
      resume({ kind: 'empty' });
      await starting;
    });

    it("a save before the next book is loaded (a lock-screen pause) is the previous book's, to its server", async () => {
      await startBook(makeBook(), 0, 'c1');
      playing();
      const { resume, starting } = await startOnOtherServer();
      mockSaveProgress.mockClear();
      // The old book is still the engine's and `nowPlaying`: paused from the lock screen.
      pushSnapshot(snap('paused', 45));
      await flushMicrotasks();
      expect(mockSaveProgress).toHaveBeenCalledWith(
        fakeClient,
        expect.objectContaining({ connectionId: 'c1', position: 45 }),
      );
      expect(mockSaveProgress).not.toHaveBeenCalledWith(client2, expect.anything());
      resume({ kind: 'empty' });
      await starting;
    });

    it('a listening span of the previous book before the next one loads goes to its server', async () => {
      await startBook(makeBook(), 0, 'c1');
      playing();
      const { resume, starting } = await startOnOtherServer();
      client2.addHistory.mockClear();
      const addHistory = fakeClient.addHistory as jest.Mock;
      addHistory.mockClear();
      // The old book, paused and played again from the lock screen, pauses once more: a span
      // long enough to keep.
      pushSnapshot(snap('paused', 45));
      pushSnapshot(snap('playing', 45));
      jest.advanceTimersByTime(45_000);
      pushSnapshot(snap('paused', 90));
      await flushMicrotasks();
      expect(addHistory).toHaveBeenCalledWith(
        2,
        'A/Book.m4b',
        expect.objectContaining({ from_pos: 45 }),
        expect.anything(),
      );
      expect(client2.addHistory).not.toHaveBeenCalled();
      resume({ kind: 'empty' });
      await starting;
    });

    // The next book is a download whose connection is gone, so the switch holds no client at
    // all: the span of the book still playing is its own server's all the same.
    it('a listening span of the previous book is kept when the next book has no client', async () => {
      await startBook(makeBook(), 0, 'c1');
      playing();
      const other = makeBook({ rel_path: 'B/Other.m4b' });
      const entry: DownloadEntry = {
        connectionId: 'c2',
        libraryId: 2,
        path: other.rel_path,
        title: 'Other',
        status: 'downloaded',
        progress: 1,
        bytes: 0,
        totalBytes: 0,
        manifest: {
          book: other,
          chapters: null,
          files: [{ relPath: other.rel_path, localUri: 'file:///dl/other.m4b' }],
          coverUri: null,
          savedAt: '2026-01-01T00:00:00Z',
        },
      };
      useDownloads.setState({ entries: { [`c2:2:${other.rel_path}`]: entry } });
      mockResolveClient.mockImplementation((cid: string) => (cid === 'c2' ? null : fakeClient));
      const { resume, starting } = await startOnOtherServer();
      const addHistory = fakeClient.addHistory as jest.Mock;
      addHistory.mockClear();
      pushSnapshot(snap('paused', 45));
      pushSnapshot(snap('playing', 45));
      jest.advanceTimersByTime(45_000);
      pushSnapshot(snap('paused', 90));
      await flushMicrotasks();
      expect(addHistory).toHaveBeenCalledWith(
        2,
        'A/Book.m4b',
        expect.objectContaining({ from_pos: 45 }),
        expect.anything(),
      );
      resume({ kind: 'empty' });
      await starting;
    });
  });

  it('finding 5: switching profiles cancels a pending resume before load or play', async () => {
    useProfiles.setState({
      hydrated: true,
      activeProfileId: 'alice',
      profiles: [
        { id: 'alice', name: 'Alice', connectionIds: ['c1'] },
        { id: 'bob', name: 'Bob', connectionIds: ['c9'] },
      ],
    });
    let resume!: (value: ResumeLookup) => void;
    mockLoadInitialProgress.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resume = resolve;
        }),
    );
    try {
      const starting = usePlayer.getState().playBook('c1', 2, makeBook());
      for (let i = 0; i < 40; i++) await Promise.resolve();
      expect(resume).toBeDefined();
      await switchProfile('bob');
      resume({ kind: 'empty' });
      await starting;
      expect(mockSvc.load).not.toHaveBeenCalled();
      expect(mockSvc.play).not.toHaveBeenCalled();
      expect(usePlayer.getState().nowPlaying).toBeNull();
      expect(mockSaveProgress).not.toHaveBeenCalled();
    } finally {
      resetProfilesForTests();
    }
  });

  it('finding 5: switching profiles while the book loads never plays it, nor leaves it loading', async () => {
    useProfiles.setState({
      hydrated: true,
      activeProfileId: 'alice',
      profiles: [
        { id: 'alice', name: 'Alice', connectionIds: ['c1'] },
        { id: 'bob', name: 'Bob', connectionIds: ['c9'] },
      ],
    });
    let landed!: () => void;
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          landed = resolve;
        }),
    );
    try {
      const starting = usePlayer.getState().playBook('c1', 2, makeBook());
      for (let i = 0; i < 40; i++) await Promise.resolve();
      expect(landed).toBeDefined();
      expect(usePlayer.getState().loadingBook).not.toBeNull();
      await switchProfile('bob'); // stops Alice's book (it is nowPlaying by now)
      (mockSvc.reset as jest.Mock).mockClear();
      landed();
      await starting;
      expect(mockSvc.play).not.toHaveBeenCalled();
      expect(mockSvc.reset).toHaveBeenCalled(); // the load landed after stop's reset
      expect(usePlayer.getState().nowPlaying).toBeNull();
      // Not left "loading": an adoption (a car or Cast book of Bob's) stands back while set.
      expect(usePlayer.getState().loadingBook).toBeNull();
    } finally {
      resetProfilesForTests();
    }
  });

  // Decision 7 regression (Phase 8): the one "only the person listening may play" rule
  // (`mayActFor`) is enforced here, so the player route, the car and every start obey it.
  it("never starts another person's book, nor anyone's while nobody is chosen", async () => {
    try {
      useProfiles.setState({
        hydrated: true,
        profiles: [
          { id: 'sam', name: 'Sam', connectionIds: ['c9'] },
          { id: 'alex', name: 'Alex', connectionIds: ['c1'], hasPin: true },
        ],
        activeProfileId: 'sam',
      });
      await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 0);
      expect(mockSvc.load).not.toHaveBeenCalled();
      expect(usePlayer.getState().nowPlaying).toBeNull();
      useProfiles.setState({ activeProfileId: null });
      await usePlayer.getState().playBook('c9', 2, makeBook(), undefined, 0);
      expect(mockSvc.load).not.toHaveBeenCalled();
      // The listening person's own book plays.
      useProfiles.setState({ activeProfileId: 'sam' });
      await usePlayer.getState().playBook('c9', 2, makeBook(), undefined, 0);
      expect(usePlayer.getState().nowPlaying?.connectionId).toBe('c9');
    } finally {
      resetProfilesForTests();
    }
  });

  it('persist stamps the connectionId of the loaded connection into the save', async () => {
    await usePlayer.getState().playBook('c9', 2, makeBook(), undefined, 0);

    mockSaveProgress.mockClear();
    pushSnapshot(snap('playing', 40));
    pushSnapshot(snap('paused', 40));
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ connectionId: 'c9', position: 40 });
  });

  it('does NOT hot-swap when a download completes for the same (lib,path) under a DIFFERENT connection', async () => {
    // Book is playing through connection c1.
    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 0);
    pushSnapshot(snap('playing', 10));
    await Promise.resolve();

    (mockSvc.load as jest.Mock).mockClear();
    (mockSvc.setRate as jest.Mock).mockClear();

    // A download for the SAME (libraryId, path) but a DIFFERENT connection (c2) finishes.
    const manifest: DownloadManifest = {
      book: makeBook(),
      chapters: null,
      files: [{ relPath: 'A/Book.m4b', localUri: 'file:///c2/0.m4b' }],
      coverUri: null,
      savedAt: '2026-01-01T00:00:00Z',
    };
    const c2Entry: DownloadEntry = {
      connectionId: 'c2',
      libraryId: 2,
      path: 'A/Book.m4b',
      title: 'A Book',
      status: 'downloaded',
      progress: 1,
      bytes: 0,
      totalBytes: 0,
      manifest,
    };
    // The subscribe listener sees prev (no entry) → downloaded, but the key is scoped to
    // c2, not the playing book's c1, so switchCurrentBookToLocal must not fire.
    useDownloads.setState({ entries: { 'c2:2:A/Book.m4b': c2Entry } });
    await Promise.resolve();
    await Promise.resolve();

    // No swap onto the other connection's local files (no reload past the initial play).
    expect(mockSvc.load).not.toHaveBeenCalled();
    // Still streaming through c1, its queue untouched.
    expect(usePlayer.getState().nowPlaying?.connectionId).toBe('c1');
    expect(usePlayer.getState().nowPlaying?.queue.tracks[0].url).not.toBe('file:///c2/0.m4b');
  });
});

describe('the download hot-swap', () => {
  /** The playing book's own download landing (c1, the book `startBook` plays). */
  function downloadLands() {
    const book = makeBook();
    const manifest: DownloadManifest = {
      book,
      chapters: null,
      files: [{ relPath: book.rel_path, localUri: 'file:///dl/0.m4b' }],
      coverUri: null,
      savedAt: '2026-01-01T00:00:00Z',
    };
    const entry: DownloadEntry = {
      connectionId: 'c1',
      libraryId: 2,
      path: book.rel_path,
      title: book.title,
      status: 'downloaded',
      progress: 1,
      bytes: 0,
      totalBytes: 0,
      manifest,
    };
    useDownloads.setState({ entries: { [`c1:2:${book.rel_path}`]: entry } });
  }
  const loadedUrls = () =>
    (mockSvc.load as jest.Mock).mock.calls.map((c) => (c[0] as { url: string }[])[0].url);

  // Decision 7 regression (8b-1): a kid's first tap on a short story on an iPhone loaded it
  // and stopped on Play. The story's automatic download landed while the start was still on
  // its way (the snapshot `loading`; the engine had begun, its `playing` not yet in JS), and
  // the swap played on only from `playing`: iOS's `load` pauses the player, so it stayed
  // stopped, with no error (the engine's pause then read as the listener's own).
  it('plays on when the download lands while the book is still starting', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('ready', 0)); // the load's own report, still starting
    expect(usePlayer.getState().snapshot.state).toBe('loading');
    (mockSvc.load as jest.Mock).mockClear();
    (mockSvc.play as jest.Mock).mockClear();

    downloadLands();
    await flushMicrotasks();

    expect(loadedUrls()).toEqual(['file:///dl/0.m4b']);
    expect(mockSvc.play).toHaveBeenCalledTimes(1);
    expect((mockSvc.play as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(
      (mockSvc.load as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it('plays on when the download lands while the book plays', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 10));
    (mockSvc.play as jest.Mock).mockClear();

    downloadLands();
    await flushMicrotasks();

    expect(loadedUrls()).toEqual(['stream:2:A/Book.m4b', 'file:///dl/0.m4b']);
    expect(mockSvc.play).toHaveBeenCalledTimes(1);
  });

  // fe#166: Download while an episode streams: it plays on from its download.
  it('switches a streaming episode onto its download', async () => {
    const episode = makeEpisode();
    await startBook(episode, 0);
    pushSnapshot(snap('playing', 10));
    (mockSvc.play as jest.Mock).mockClear();

    useDownloads.setState({
      entries: {
        'c1:2:Show/Ep.mp3': {
          connectionId: 'c1',
          libraryId: 2,
          path: 'Show/Ep.mp3',
          title: episode.title,
          status: 'downloaded',
          progress: 1,
          bytes: 0,
          totalBytes: 0,
          manifest: {
            book: episode,
            chapters: null,
            files: [{ relPath: 'Show/Ep.mp3', localUri: 'file:///dl/0.mp3' }],
            coverUri: null,
            savedAt: '2026-01-01T00:00:00Z',
          },
        },
      },
    });
    await flushMicrotasks();

    expect(loadedUrls()).toEqual(['stream:2:Show/Ep.mp3', 'file:///dl/0.mp3']);
    expect(mockSvc.play).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState().nowPlaying?.episode).toBe(true);
  });

  it('stays paused when the download lands on a book the listener paused', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 10));
    await usePlayer.getState().pause();
    pushSnapshot(snap('paused', 10));
    (mockSvc.play as jest.Mock).mockClear();

    downloadLands();
    await flushMicrotasks();

    expect(loadedUrls()).toEqual(['stream:2:A/Book.m4b', 'file:///dl/0.m4b']);
    expect(mockSvc.play).not.toHaveBeenCalled();
  });
});

// --- a downloaded book whose server now plays its files in another order -----------
// (server v2.4.0's natural order: "2-" before "10-"). The download takes the server's order
// and chapters only from a start that loaded the engine in it.
describe('a downloaded book re-ordered on its server', () => {
  const folder = 'A/Folder';
  const paths = ['A/Folder/10.mp3', 'A/Folder/2.mp3'];
  const serverOrder = ['A/Folder/2.mp3', 'A/Folder/10.mp3'];
  const chaptersIn = (order: string[]): ChaptersResponse => ({
    library_id: 2,
    path: folder,
    duration: 100,
    is_folder: true,
    files: order.map((rel_path, seq) => ({ rel_path, seq, duration: 50, format: 'mp3', size: 1 })),
    chapters: order.map((file_path, index) => ({
      index,
      title: `Chapter ${index + 1}`,
      file_index: index,
      file_path,
      start: 0,
      end: 50,
      book_offset: index * 50,
    })),
  });
  const book = makeBook({ rel_path: folder, is_folder: true, format: 'mp3' });
  const key = `c1:2:${folder}`;
  /** The order the download plays its files in (its chapters'; `files` never moves). */
  const order = () => {
    const { manifest } = useDownloads.getState().entries[key];
    return bookFileSpecs(manifest.book, manifest.chapters ?? undefined).map((s) => s.path);
  };

  beforeEach(() => {
    const manifest: DownloadManifest = {
      book,
      chapters: chaptersIn(paths),
      files: paths.map((relPath, i) => ({ relPath, localUri: `file:///dl/${i}.mp3` })),
      coverUri: null,
      savedAt: '2026-01-01T00:00:00Z',
    };
    useDownloads.setState({
      entries: {
        [key]: {
          connectionId: 'c1',
          libraryId: 2,
          path: folder,
          title: book.title,
          status: 'downloaded',
          progress: 1,
          bytes: 0,
          totalBytes: 0,
          manifest,
        },
      },
    });
    // The server's answer, in its new order, sits in the query cache.
    const chaptersKey = JSON.stringify(qk.chapters('c1', 2, folder));
    (queryClient.getQueryData as jest.Mock).mockImplementation((k: unknown) =>
      JSON.stringify(k) === chaptersKey
        ? chaptersIn(serverOrder)
        : (k as unknown[])[0] === 'server'
          ? { capabilities: {} }
          : undefined,
    );
  });
  afterEach(() =>
    (queryClient.getQueryData as jest.Mock).mockImplementation((k: readonly unknown[]) =>
      k?.[0] === 'server' ? { capabilities: {} } : undefined,
    ),
  );

  it("takes the server's order once a start plays it", async () => {
    await usePlayer.getState().playBook('c1', 2, book, chaptersIn(serverOrder), 0);
    const tracks = usePlayer.getState().nowPlaying?.queue.tracks.map((t) => t.url);
    expect(tracks).toEqual(['file:///dl/1.mp3', 'file:///dl/0.mp3']);
    expect(order()).toEqual(serverOrder);
    // The files stay where the download wrote them.
    expect(useDownloads.getState().entries[key].manifest.files.map((f) => f.relPath)).toEqual(
      paths,
    );
  });

  it('keeps the old order for an offline start, and after it, whatever the cache holds', async () => {
    // Started from the download's own copy (offline, or the fresh read timed out).
    await usePlayer.getState().playBook('c1', 2, book, chaptersIn(paths), 0);
    const tracks = usePlayer.getState().nowPlaying?.queue.tracks.map((t) => t.url);
    expect(tracks).toEqual(['file:///dl/0.mp3', 'file:///dl/1.mp3']);
    expect(order()).toEqual(paths);
    // The book unloads: the server's answer in the cache is still not taken.
    usePlayer.setState({ nowPlaying: null });
    expect(order()).toEqual(paths);
  });

  // fe#273: the end credits read the book's end from the loaded queue (`over` in
  // end-credits.tsx: the place against the queue's length, never on a partial queue). An
  // old-order download ends in another file than the server's order does, and is still
  // the whole book.
  it("ends the whole book at the old order's last file: finished, never a partial end", async () => {
    await usePlayer.getState().playBook('c1', 2, book, chaptersIn(paths), 0);
    mockSaveProgress.mockClear();
    pushSnapshot(snap('playing', 40, { trackIndex: 1, duration: 50 }));
    pushSnapshot(snap('ended', 50, { trackIndex: 1, duration: 50 }));
    await flushMicrotasks();
    const s = usePlayer.getState();
    expect(selectEndsPartial(s)).toBe(false);
    expect(selectBookPosition(s)).toBe(100);
    expect(mockSaveProgress.mock.calls.at(-1)?.[1]).toMatchObject({
      position: 100,
      duration: 100,
      finished: true,
    });
  });

  it("plays the download's order when a start has no chapters for it", async () => {
    // The server's item lists the files in its new order; its chapters read failed.
    const fresh = { ...book, files: chaptersIn(serverOrder).files };
    await usePlayer.getState().playBook('c1', 2, fresh, undefined, 0);
    const tracks = usePlayer.getState().nowPlaying?.queue.tracks.map((t) => t.url);
    expect(tracks).toEqual(['file:///dl/0.mp3', 'file:///dl/1.mp3']);
    expect(order()).toEqual(paths);
  });

  it("plays the download's file list when it saved no chapters and a start has none", async () => {
    const e = useDownloads.getState().entries[key];
    const saved = { ...book, files: chaptersIn(paths).files };
    useDownloads.setState({
      entries: { [key]: { ...e, manifest: { ...e.manifest, book: saved, chapters: null } } },
    });
    const fresh = { ...book, files: chaptersIn(serverOrder).files };
    await usePlayer.getState().playBook('c1', 2, fresh, undefined, 0);
    const tracks = usePlayer.getState().nowPlaying?.queue.tracks.map((t) => t.url);
    expect(tracks).toEqual(['file:///dl/0.mp3', 'file:///dl/1.mp3']);
    expect(order()).toEqual(paths);
  });

  it('takes nothing from a start overtaken by another before its load landed', async () => {
    let loaded: () => void = () => {};
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (loaded = resolve)),
    );
    const start = usePlayer.getState().playBook('c1', 2, book, chaptersIn(serverOrder), 0);
    await flushMicrotasks();
    // Another book starts while this load is on its way: it owns the engine.
    await startBook(makeBook(), 0);
    loaded();
    await start;
    expect(order()).toEqual(paths);
  });
});

// --- the download hot-swap when the download orders its files differently ---------------
// (a download made before server v2.4.0's natural order, retried while the new order
// streams). The download takes the order the engine plays, so the swap keeps the listener
// in the same file at the same place in it, on the same whole-book timeline.
describe('the download hot-swap across file orders', () => {
  const folder = 'A/Folder';
  const key = `c1:2:${folder}`;
  // Different lengths, so a place read on the other order's timeline lands in another file.
  const durations: Record<string, number> = { 'A/Folder/10.mp3': 30, 'A/Folder/2.mp3': 70 };
  const lengthOf = (path: string) => durations[path] ?? 50;
  const oldOrder = ['A/Folder/10.mp3', 'A/Folder/2.mp3'];
  const newOrder = ['A/Folder/2.mp3', 'A/Folder/10.mp3'];
  /** Files renamed on the server since the download (50 s each). */
  const renamed = ['A/Folder/a.mp3', 'A/Folder/b.mp3'];
  /** One chapter per file, in `order` (`buildBookQueue` works out their offsets). */
  const chaptersIn = (order: string[]): ChaptersResponse => ({
    library_id: 2,
    path: folder,
    duration: 100,
    is_folder: true,
    files: order.map((rel_path, seq) => ({
      rel_path,
      seq,
      duration: lengthOf(rel_path),
      format: 'mp3',
      size: 1,
    })),
    chapters: order.map((file_path, index) => ({
      index,
      title: `Chapter ${index + 1}`,
      file_index: index,
      file_path,
      start: 0,
      end: lengthOf(file_path),
      book_offset: 0,
    })),
  });
  const book = makeBook({ rel_path: folder, is_folder: true, format: 'mp3' });
  const urlOf = (path: string) => `file:///dl/${path.split('/').pop()}`;
  const queueUrls = () => usePlayer.getState().nowPlaying?.queue.tracks.map((t) => t.url);

  /** The download lands, its files (and chapters) in `order`, its item `item`. */
  function downloadLands(order: string[], item = book) {
    const manifest: DownloadManifest = {
      book: item,
      chapters: chaptersIn(order),
      files: order.map((relPath) => ({ relPath, localUri: urlOf(relPath) })),
      coverUri: null,
      savedAt: '2026-01-01T00:00:00Z',
    };
    useDownloads.setState({
      entries: {
        [key]: {
          connectionId: 'c1',
          libraryId: 2,
          path: folder,
          title: book.title,
          status: 'downloaded',
          progress: 1,
          bytes: 0,
          totalBytes: 0,
          manifest,
        },
      },
    });
  }
  /** The order the download plays its files in (its chapters'; `files` never moves). */
  const downloadOrder = () => {
    const { manifest } = useDownloads.getState().entries[key];
    return bookFileSpecs(manifest.book, manifest.chapters ?? undefined).map((s) => s.path);
  };
  /** Where a swap (`load` or `swapTo`) started: the url, its index, the place in it. */
  const startOf = (call: unknown[]) => {
    const [tracks, index, position] = call as [{ url: string }[], number, number];
    return { url: tracks[index].url, index, position };
  };
  const swapLoad = () => startOf((mockSvc.load as jest.Mock).mock.lastCall ?? []);

  /** Stream the book in `order` (started with its chapters), `at` seconds into `file`,
   * playing or paused there. */
  async function streamIn(
    order: string[],
    { file = 'A/Folder/2.mp3', at = 20, paused = false } = {},
  ) {
    await usePlayer.getState().playBook('c1', 2, book, chaptersIn(order), 0);
    const place = { trackIndex: order.indexOf(file), duration: lengthOf(file) };
    pushSnapshot(snap('playing', at, place));
    if (paused) {
      await usePlayer.getState().pause();
      pushSnapshot(snap('paused', at, place));
    }
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    mockSaveProgress.mockClear();
  }

  it('gives the download the order the engine plays, and swaps at the same place', async () => {
    await streamIn(newOrder);
    downloadLands(oldOrder);
    await flushMicrotasks();
    // 2.mp3 at the stream's own index, with 10.mp3 still after it.
    expect(swapLoad()).toEqual({ url: urlOf('A/Folder/2.mp3'), index: 0, position: 20 });
    expect(queueUrls()).toEqual(newOrder.map(urlOf));
    expect(downloadOrder()).toEqual(newOrder);
    // The files stay where the download wrote them.
    expect(useDownloads.getState().entries[key].manifest.files.map((f) => f.relPath)).toEqual(
      oldOrder,
    );
    // The same whole-book place, on the same timeline.
    expect(selectBookPosition(usePlayer.getState())).toBe(20);
  });

  it("measures a run held during a load onto other indexes on the store's queue (iOS)", async () => {
    // Streaming 20 s into 2.mp3 (index 0); the download holds a file before it, so its load
    // puts 2.mp3 at index 1, and the engine reports its own indexes until the commit.
    await streamIn(newOrder);
    const landLoad = holdNextLoad();
    downloadLands(['A/Folder/a.mp3', ...newOrder]);
    await flushMicrotasks();
    expect(swapLoad()).toEqual({ url: urlOf('A/Folder/2.mp3'), index: 1, position: 20 });
    // The engine measured the download's 2.mp3 short: it runs on into its 10.mp3 (index 2),
    // ticks a second of the media apart reaching JS at once. Read against the engine's own
    // index, the fourth would look like a move into the file at 3 s.
    for (let p = 0; p <= 3; p++) {
      pushSnapshot(snap('playing', p, { trackIndex: 2, duration: 30 }));
    }
    jest.advanceTimersByTime(FAULT_HOLD_MS);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 20,
    });
    landLoad();
    await flushMicrotasks();
  });

  it("measures a run held across the swap's commit on the download's queue (iOS)", async () => {
    await streamIn(newOrder);
    const landLoad = holdNextLoad();
    downloadLands(['A/Folder/a.mp3', ...newOrder]);
    await flushMicrotasks();
    // The engine runs off the download's 2.mp3 into its 10.mp3 (index 2) while the load is out,
    // then the load lands and the store holds the download's queue, the run going on.
    pushSnapshot(snap('playing', 0, { trackIndex: 2, duration: 30 }));
    pushSnapshot(snap('playing', 1, { trackIndex: 2, duration: 30 }));
    landLoad();
    await flushMicrotasks();
    // A second of the media on: no move of the listener's, read on either queue.
    pushSnapshot(snap('playing', 2.5, { trackIndex: 2, duration: 30 }));
    jest.advanceTimersByTime(FAULT_HOLD_MS);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 20 });
  });

  it('swaps at the same index and place when the orders match', async () => {
    await streamIn(newOrder);
    downloadLands(newOrder);
    await flushMicrotasks();
    expect(swapLoad()).toEqual({ url: urlOf('A/Folder/2.mp3'), index: 0, position: 20 });
  });

  it("keeps streaming when the download can't take the order the engine plays", async () => {
    // Started with no chapters (their read failed): the item's file list streams.
    const listed = { ...book, files: chaptersIn(newOrder).files };
    await usePlayer.getState().playBook('c1', 2, listed, undefined, 0);
    pushSnapshot(snap('playing', 20, { trackIndex: 0, duration: 70 }));
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    downloadLands(oldOrder);
    await flushMicrotasks();
    // Moved onto the download's order, the book would end after 2.mp3, skipping 10.mp3.
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(queueUrls()).toEqual(['stream:2:A/Folder/2.mp3', 'stream:2:A/Folder/10.mp3']);
    expect(downloadOrder()).toEqual(oldOrder);
  });

  it("Retry reloads a dead stream from a download in the download's own order (fe#278)", async () => {
    // As above: the download can't take the stream's order, so it was not swapped in.
    const listed = { ...book, files: chaptersIn(newOrder).files };
    await usePlayer.getState().playBook('c1', 2, listed, undefined, 0);
    pushSnapshot(snap('playing', 20, { trackIndex: 0, duration: 70 }));
    pushSnapshot(snap('error', 20, { trackIndex: 0, duration: 70 }));
    await flushMicrotasks();
    downloadLands(oldOrder);
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().retry();
    // Nothing plays for the new order to cut into: the same file, 20 s in, where the
    // download plays it (after 10.mp3's 30 s).
    expect(queueUrls()).toEqual(oldOrder.map(urlOf));
    expect(swapLoad()).toEqual({ url: urlOf('A/Folder/2.mp3'), index: 1, position: 20 });
    expect(selectBookPosition(usePlayer.getState())).toBe(50);
  });

  it('gives the download no chapters that would make it play another order', async () => {
    // Started from chapters with no file list: the item's own list (the new order) streams.
    const listed = { ...book, files: chaptersIn(newOrder).files };
    await usePlayer.getState().playBook('c1', 2, listed, { ...chaptersIn(newOrder), files: [] }, 0);
    pushSnapshot(snap('playing', 20, { trackIndex: 0, duration: 70 }));
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    // The download already plays the new order (its chapters'), but its item lists the old:
    // taking the start's chapters would make it play the item's list, the old order.
    downloadLands(newOrder, { ...book, files: chaptersIn(oldOrder).files });
    await flushMicrotasks();
    expect(downloadOrder()).toEqual(newOrder);
    expect(swapLoad()).toEqual({ url: urlOf('A/Folder/2.mp3'), index: 0, position: 20 });
  });

  it('falls back to the whole-book place for a file the download does not hold', async () => {
    // 20 s into 10.mp3: whole-book 70 + 20 on the stream's timeline.
    await streamIn(newOrder, { file: 'A/Folder/10.mp3' });
    downloadLands(renamed);
    await flushMicrotasks();
    // Whole-book 90 on the download's timeline: 40 s into its second file.
    expect(swapLoad()).toEqual({ url: urlOf('A/Folder/b.mp3'), index: 1, position: 40 });
  });

  it("saves no place read through the stream's queue while the swap moves the file's index", async () => {
    // Paused 60 s into 2.mp3; whole-book 60 is 10 s into the renamed download's second file.
    await streamIn(newOrder, { at: 60, paused: true });
    // Like the native engine: the load reports its new index (`ready`) before it returns,
    // which settles a paused book and asks for a save.
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      async (_tracks: unknown, index: number, position: number) => {
        pushSnapshot(snap('ready', position, { trackIndex: index, duration: 50 }));
      },
    );
    downloadLands(renamed);
    await flushMicrotasks();
    expect(swapLoad()).toEqual({ url: urlOf('A/Folder/b.mp3'), index: 1, position: 10 });
    // Index 1 through the stream's queue is 10.mp3 (70 + 10 = 80): never saved.
    expect(savedPositions()).not.toContain(80);
    // After the commit the place reads through the download's queue, and saves again.
    expect(selectBookPosition(usePlayer.getState())).toBe(60);
    pushSnapshot(snap('playing', 12, { trackIndex: 1, duration: 50 }));
    pushSnapshot(snap('paused', 15, { trackIndex: 1, duration: 50 }));
    await flushMicrotasks();
    expect(savedPositions()).toContain(65);
  });

  it('releases that hold when the swap load fails', async () => {
    await streamIn(newOrder, { at: 60 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (mockSvc.load as jest.Mock).mockImplementationOnce(
        async (_tracks: unknown, index: number, position: number) => {
          // The engine reported the download's index (and settled) before the load failed.
          pushSnapshot(snap('paused', position, { trackIndex: index, duration: 50 }));
          throw new Error('no file');
        },
      );
      downloadLands(renamed);
      await flushMicrotasks();
      expect(warn).toHaveBeenCalledWith(
        '[player] could not move onto the downloaded copy',
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
    // Held while the engine reported the download's index (70 + 10 through the stream's)...
    expect(savedPositions()).not.toContain(80);
    // ...and released after: still the stream's queue, whose places save, in any file.
    expect(queueUrls()?.[0]).toBe('stream:2:A/Folder/2.mp3');
    pushSnapshot(snap('playing', 5, { trackIndex: 1, duration: 30 }));
    pushSnapshot(snap('paused', 8, { trackIndex: 1, duration: 30 }));
    await flushMicrotasks();
    expect(savedPositions()).toContain(78);
  });

  it('moves the resume floor with a place the download reads lower', async () => {
    // Paused (and saved) 20 s into 10.mp3: whole-book 70 + 20, so the floor is 90.
    await streamIn(newOrder, { file: 'A/Folder/10.mp3', paused: true });
    // The download holds another file too, 10.mp3 first: the same place reads 20 there.
    downloadLands(['A/Folder/10.mp3', 'A/Folder/c.mp3', 'A/Folder/2.mp3']);
    await flushMicrotasks();
    expect(swapLoad()).toEqual({ url: urlOf('A/Folder/10.mp3'), index: 0, position: 20 });
    // Listening on from there saves, far below the stream's floor of 90.
    pushSnapshot(snap('playing', 25, { trackIndex: 0, duration: 30 }));
    pushSnapshot(snap('paused', 25, { trackIndex: 0, duration: 30 }));
    await flushMicrotasks();
    expect(savedPositions()).toContain(25);
  });

  /** The next `load` waits until the returned release is called (an engine still loading). */
  function holdNextLoad(report?: (index: number, position: number) => void) {
    let release: () => void = () => {};
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      (_tracks: unknown, index: number, position: number) =>
        new Promise<void>((resolve) => {
          release = () => {
            report?.(index, position);
            resolve();
          };
        }),
    );
    return () => release();
  }
  /** The download holds one more file, first: every file of the stream one index later. */
  const withExtra = ['A/Folder/c.mp3', ...newOrder];

  it('saves a stop made while the swap loads', async () => {
    await streamIn(newOrder);
    const land = holdNextLoad();
    downloadLands(oldOrder);
    await flushMicrotasks();
    await usePlayer.getState().stop();
    // The stop saved the place: nothing held it.
    expect(savedPositions()).toEqual([20]);
    (mockSvc.setRate as jest.Mock).mockClear();
    (mockSvc.play as jest.Mock).mockClear();
    land();
    await flushMicrotasks();
    // The swap landing after the stop brings nothing back: no speed set, nothing played.
    expect(usePlayer.getState().nowPlaying).toBeNull();
    expect(mockSvc.setRate).not.toHaveBeenCalled();
    expect(mockSvc.play).not.toHaveBeenCalled();
  });

  it("waits for a start's load before swapping, and swaps at that start's place", async () => {
    // Another book plays 50 s in; this book's start (10 s into 10.mp3) is still loading.
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 50));
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    const land = holdNextLoad((index, position) =>
      pushSnapshot(snap('ready', position, { trackIndex: index, duration: 30 })),
    );
    const start = usePlayer.getState().playBook('c1', 2, book, chaptersIn(newOrder), 80);
    await flushMicrotasks(20);
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    downloadLands(oldOrder);
    await flushMicrotasks(20);
    // Nothing swaps while the start's load is out: the place is still the other book's.
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    land();
    await start;
    await flushMicrotasks(20);
    expect(mockSvc.load).toHaveBeenCalledTimes(2);
    expect(swapLoad()).toEqual({ url: urlOf('A/Folder/10.mp3'), index: 1, position: 10 });
    expect(queueUrls()).toEqual(newOrder.map(urlOf));
  });

  it("waits for a start of the same book too, and swaps at that start's place", async () => {
    // 20 s into 2.mp3; the book is started again 10 s into 10.mp3, its load still out.
    await streamIn(newOrder);
    const land = holdNextLoad((index, position) =>
      pushSnapshot(snap('ready', position, { trackIndex: index, duration: 30 })),
    );
    const start = usePlayer.getState().playBook('c1', 2, book, chaptersIn(newOrder), 80);
    await flushMicrotasks(20);
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    downloadLands(oldOrder);
    await flushMicrotasks(20);
    // A swap now would load the place before the restart, after the restart's own load.
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    land();
    await start;
    await flushMicrotasks(20);
    expect(mockSvc.load).toHaveBeenCalledTimes(2);
    expect(swapLoad()).toEqual({ url: urlOf('A/Folder/10.mp3'), index: 1, position: 10 });
    expect(queueUrls()).toEqual(newOrder.map(urlOf));
  });

  it("swaps in a download that landed before the start made the book the store's", async () => {
    // Nothing plays yet: the download lands while this start still looks up its place.
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      async (_tracks: unknown, index: number, position: number) => {
        pushSnapshot(snap('ready', position, { trackIndex: index, duration: 30 }));
      },
    );
    const start = usePlayer.getState().playBook('c1', 2, book, chaptersIn(newOrder), 80);
    expect(usePlayer.getState().nowPlaying).toBeNull();
    downloadLands(oldOrder);
    await start;
    await flushMicrotasks(20);
    // The start streamed (it saw no download), then the copy took over at its place.
    expect(mockSvc.load).toHaveBeenCalledTimes(2);
    expect(startOf((mockSvc.load as jest.Mock).mock.calls[0]).url).toBe('stream:2:A/Folder/10.mp3');
    expect(swapLoad()).toEqual({ url: urlOf('A/Folder/10.mp3'), index: 1, position: 10 });
    expect(queueUrls()).toEqual(newOrder.map(urlOf));
  });

  it("swaps nothing after a start's load that failed", async () => {
    // Another book plays 50 s in; this book's start fails in its load, the download landed.
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 50));
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    let fail: () => void = () => {};
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((_, reject) => (fail = () => reject(new Error('no stream')))),
    );
    const start = usePlayer.getState().playBook('c1', 2, book, chaptersIn(newOrder), 80);
    const failed = expect(start).rejects.toThrow('no stream');
    await flushMicrotasks(20);
    downloadLands(oldOrder);
    await flushMicrotasks(20);
    fail();
    await failed;
    await flushMicrotasks(20);
    // The snapshot is still the other book's place: nothing to swap from.
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    expect(queueUrls()).toEqual(['stream:2:A/Folder/2.mp3', 'stream:2:A/Folder/10.mp3']);
  });

  it('keeps a pause made while the swap loads, and a speed set meanwhile', async () => {
    await streamIn(newOrder);
    const land = holdNextLoad();
    downloadLands(oldOrder);
    await flushMicrotasks();
    (mockSvc.play as jest.Mock).mockClear();
    await usePlayer.getState().setRate(1.5);
    await usePlayer.getState().pause();
    land();
    await flushMicrotasks();
    expect(queueUrls()).toEqual(newOrder.map(urlOf));
    expect(mockSvc.play).not.toHaveBeenCalled();
    expect((mockSvc.setRate as jest.Mock).mock.lastCall).toEqual([1.5]);
  });

  it('plays on at a speed set while the swap loads', async () => {
    await streamIn(newOrder);
    const land = holdNextLoad();
    downloadLands(oldOrder);
    await flushMicrotasks();
    (mockSvc.play as jest.Mock).mockClear();
    await usePlayer.getState().setRate(1.5);
    land();
    await flushMicrotasks();
    expect((mockSvc.setRate as jest.Mock).mock.lastCall).toEqual([1.5]);
    expect(mockSvc.play).toHaveBeenCalledTimes(1);
  });

  it('keeps a pause the engine has not reported yet when the download lands', async () => {
    await streamIn(newOrder);
    // Pressed, the engine asked: its `paused` has not arrived, the snapshot still plays.
    await usePlayer.getState().pause();
    expect(usePlayer.getState().snapshot.state).toBe('playing');
    (mockSvc.play as jest.Mock).mockClear();
    downloadLands(oldOrder);
    await flushMicrotasks();
    expect(swapLoad()).toEqual({ url: urlOf('A/Folder/2.mp3'), index: 0, position: 20 });
    expect(mockSvc.play).not.toHaveBeenCalled();
    // No play attempt was begun for it either: the pause settles as one, no stall error.
    pushSnapshot(snap('paused', 20, { trackIndex: 0, duration: 70 }));
    expect(usePlayer.getState().snapshot.state).toBe('paused');
    jest.advanceTimersByTime(4_000);
    expect(usePlayer.getState().snapshot.state).toBe('paused');
  });

  it('begins no play for a download landing while a stop saves the place', async () => {
    await streamIn(newOrder);
    let saved: () => void = () => {};
    mockSaveProgress.mockImplementationOnce(
      () => new Promise<void>((resolve) => (saved = resolve)),
    );
    const stop = usePlayer.getState().stop();
    await flushMicrotasks();
    (mockSvc.play as jest.Mock).mockClear();
    downloadLands(oldOrder);
    await flushMicrotasks();
    // The swap's load landed with the book still the store's: it must not play it again.
    expect(mockSvc.play).not.toHaveBeenCalled();
    saved();
    await stop;
    await flushMicrotasks();
    jest.advanceTimersByTime(4_000);
    expect(usePlayer.getState().nowPlaying).toBeNull();
    expect(usePlayer.getState().snapshot.state).not.toBe('error');
  });

  it("plays on a play asked for while a paused book's swap loads", async () => {
    await streamIn(newOrder, { paused: true });
    const land = holdNextLoad();
    downloadLands(oldOrder);
    await flushMicrotasks();
    (mockSvc.play as jest.Mock).mockClear();
    await usePlayer.getState().toggle();
    expect(mockSvc.play).toHaveBeenCalledTimes(1);
    land();
    await flushMicrotasks();
    // iOS's `load` paused the engine again: the play is made once more on the copy.
    expect(queueUrls()).toEqual(newOrder.map(urlOf));
    expect(mockSvc.play).toHaveBeenCalledTimes(2);
  });

  it('ends the start window of a swap whose load failed with the stream playing on', async () => {
    await streamIn(newOrder);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (mockSvc.load as jest.Mock).mockRejectedValueOnce(new Error('no file'));
      downloadLands(oldOrder);
      await flushMicrotasks();
    } finally {
      warn.mockRestore();
    }
    // The stream never left `playing`: past the stall grace, a lock-screen pause is a pause.
    jest.advanceTimersByTime(4_000);
    pushSnapshot(snap('paused', 25, { trackIndex: 0, duration: 70 }));
    expect(usePlayer.getState().snapshot.state).toBe('paused');
  });

  it("saves the playing file's place on a stop after the engine reported the download's index", async () => {
    // 20 s into 10.mp3: whole-book 70 + 20; the download holds it at index 2.
    await streamIn(newOrder, { file: 'A/Folder/10.mp3' });
    const land = holdNextLoad();
    downloadLands(withExtra);
    await flushMicrotasks();
    expect(swapLoad()).toEqual({ url: urlOf('A/Folder/10.mp3'), index: 2, position: 20 });
    // The engine is on the download already (its index reported), the store not yet.
    pushSnapshot(snap('playing', 21, { trackIndex: 2, duration: 30 }));
    await usePlayer.getState().stop();
    expect(savedPositions()).toEqual([91]);
    land();
    await flushMicrotasks();
    expect(usePlayer.getState().nowPlaying).toBeNull();
  });

  it("reads no jump and fires no chapter's sleep timer at the download's index", async () => {
    const stopWatching = startJumpUndo();
    try {
      // 20 s into 2.mp3 (chapter 1, ending at 70); the download holds it at index 1, which
      // through the stream's queue is 10.mp3: whole-book 70 + 20, past the chapter's end.
      await streamIn(newOrder);
      jest.advanceTimersByTime(4_000); // past the jump watch's settling
      pushSnapshot(snap('playing', 24, { trackIndex: 0, duration: 70 }));
      useSleepTimer.getState().startUntilPosition(70, { key: 'player.sleepTimer.endOf' });
      (mockSvc.pause as jest.Mock).mockClear();
      const land = holdNextLoad();
      downloadLands(withExtra);
      await flushMicrotasks();
      pushSnapshot(snap('playing', 25, { trackIndex: 1, duration: 70 }));
      jest.advanceTimersByTime(1_000);
      await flushMicrotasks();
      expect(useJumpUndo.getState().jump).toBeNull();
      expect(mockSvc.pause).not.toHaveBeenCalled();
      expect(useSleepTimer.getState().phase).toBe('running');
      expect(selectBookPosition(usePlayer.getState())).toBe(25);
      land();
      await flushMicrotasks();
      expect(selectBookPosition(usePlayer.getState())).toBe(75); // c.mp3's 50 + 25
    } finally {
      useSleepTimer.getState().cancel();
      stopWatching();
      clearJumpUndo();
    }
  });

  it("moves a held error's place onto the download's index at the commit", async () => {
    await streamIn(newOrder, { file: 'A/Folder/10.mp3' });
    pushSnapshot(snap('error', 20, { trackIndex: 1, duration: 30 }));
    // Like the native engine, the load reports the download's index: the error holds it out.
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      async (_tracks: unknown, index: number, position: number) => {
        pushSnapshot(snap('ready', position, { trackIndex: index, duration: 30 }));
      },
    );
    downloadLands(withExtra);
    await flushMicrotasks();
    expect(queueUrls()).toEqual(withExtra.map(urlOf));
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', trackIndex: 2 });
    expect(selectBookPosition(usePlayer.getState())).toBe(140); // 50 + 70 + 20
  });

  describe('while casting', () => {
    const cast = mockSvc as unknown as { isCasting?: () => boolean; rememberLoad?: jest.Mock };
    beforeEach(() => {
      cast.isCasting = () => true;
      cast.rememberLoad = jest.fn();
    });
    afterEach(() => {
      delete cast.isCasting;
      delete cast.rememberLoad;
    });

    it('keeps the download for the phone in the order the receiver plays', async () => {
      // The receiver plays 10.mp3, 10 s in: whole-book 70 + 10.
      await streamIn(newOrder, { file: 'A/Folder/10.mp3', at: 10 });
      downloadLands(oldOrder);
      await flushMicrotasks();
      const kept = cast.rememberLoad?.mock.calls[0]?.[0] as { tracks: { url: string }[] };
      expect(kept.tracks.map((t) => t.url)).toEqual(newOrder.map(urlOf));
      expect(mockSvc.load).not.toHaveBeenCalled();
      expect(queueUrls()).toEqual(newOrder.map(urlOf));
      // The receiver's index still reads as 10.mp3.
      expect(selectBookPosition(usePlayer.getState())).toBe(80);
    });

    it('leaves the queue alone for a download holding other files than the receiver plays', async () => {
      await streamIn(newOrder, { file: 'A/Folder/10.mp3', at: 10 });
      downloadLands(withExtra);
      await flushMicrotasks();
      expect(cast.rememberLoad).not.toHaveBeenCalled();
      expect(mockSvc.load).not.toHaveBeenCalled();
      expect(queueUrls()).toEqual(['stream:2:A/Folder/2.mp3', 'stream:2:A/Folder/10.mp3']);
      expect(selectBookPosition(usePlayer.getState())).toBe(80);
    });
  });

  describe('on the web engine (a gapless swap)', () => {
    const web = mockSvc as unknown as { swapTo?: jest.Mock };
    afterEach(() => {
      delete web.swapTo;
    });

    it('commits the queue once the swap lands', async () => {
      web.swapTo = jest.fn(async () => 'swapped');
      await streamIn(newOrder);
      downloadLands(oldOrder);
      await flushMicrotasks();
      expect(mockSvc.load).not.toHaveBeenCalled();
      expect(startOf(web.swapTo.mock.calls[0])).toEqual({
        url: urlOf('A/Folder/2.mp3'),
        index: 0,
        position: 20,
      });
      expect(queueUrls()).toEqual(newOrder.map(urlOf));
    });

    it('Retry after a failed start plays the download that landed meanwhile (fe#278)', async () => {
      web.swapTo = jest.fn(async () => 'refused');
      await streamIn(newOrder, { at: 20 });
      pushSnapshot(snap('error', 20, { trackIndex: 0, duration: 70 }));
      await flushMicrotasks();
      downloadLands(newOrder);
      await flushMicrotasks();
      // The swap did not take it: the queue still streams.
      expect(queueUrls()?.[0]).toBe('stream:2:A/Folder/2.mp3');
      useReachability.setState({ online: { c1: false } });
      (mockSvc.load as jest.Mock).mockClear();
      try {
        await usePlayer.getState().retry();
      } finally {
        useReachability.setState({ online: {} });
      }
      // Reloaded from the device, at the place it was at.
      expect(queueUrls()).toEqual(newOrder.map(urlOf));
      expect(swapLoad()).toEqual({ url: urlOf('A/Folder/2.mp3'), index: 0, position: 20 });
    });

    it('a Retry onto the download is a reload, not a fresh start (fe#278)', async () => {
      web.swapTo = jest.fn(async () => 'refused');
      let pickedUp = 0;
      const stop = onPickedUpAgain(() => pickedUp++);
      try {
        // 20 s into 10.mp3: whole-book 70 + 20.
        await streamIn(newOrder, { file: 'A/Folder/10.mp3' });
        pushSnapshot(snap('error', 20, { trackIndex: 1, duration: 30 }));
        await flushMicrotasks();
        downloadLands(newOrder);
        // Left in its error for long: another device may have played on meanwhile.
        jest.advanceTimersByTime(LONG_PAUSE_MS);
        await flushMicrotasks();
        mockLoadInitialProgress.mockClear();
        mockSaveProgress.mockClear();
        (mockSvc.load as jest.Mock).mockClear();
        await usePlayer.getState().retry();
        expect(swapLoad()).toEqual({ url: urlOf('A/Folder/10.mp3'), index: 1, position: 20 });
        // No place looked up, and none saved first: this device's old place, dated now,
        // would be the newest one there.
        expect(mockLoadInitialProgress).not.toHaveBeenCalled();
        expect(mockSaveProgress).not.toHaveBeenCalled();
        // The play asks where the book is now, as a play after any long stop does.
        pushSnapshot(snap('playing', 20, { trackIndex: 1, duration: 30 }));
        expect(pickedUp).toBe(1);
      } finally {
        stop();
      }
    });

    it('keeps the stream, and holds nothing, when the swap is refused', async () => {
      web.swapTo = jest.fn(async () => 'refused');
      await streamIn(newOrder, { at: 60 });
      downloadLands(renamed); // the swap would move the file's index
      await flushMicrotasks();
      expect(web.swapTo).toHaveBeenCalledTimes(1);
      expect(queueUrls()?.[0]).toBe('stream:2:A/Folder/2.mp3');
      // The stream plays on into 10.mp3, and its place there saves.
      pushSnapshot(snap('playing', 5, { trackIndex: 1, duration: 30 }));
      pushSnapshot(snap('paused', 8, { trackIndex: 1, duration: 30 }));
      await flushMicrotasks();
      expect(savedPositions()).toContain(78);
    });

    it('saves a stop made while the local copy buffers', async () => {
      let swapped: (outcome: SwapOutcome) => void = () => {};
      web.swapTo = jest.fn(() => new Promise<SwapOutcome>((resolve) => (swapped = resolve)));
      await streamIn(newOrder);
      downloadLands(oldOrder);
      await flushMicrotasks();
      await usePlayer.getState().stop();
      expect(savedPositions()).toEqual([20]);
      swapped('refused');
      await flushMicrotasks();
    });

    /** A swap still buffering: `switched` is the engine's switch, `swapped` its answer. */
    function bufferingSwap() {
      const swap = { switched: () => {}, swapped: (_outcome: SwapOutcome) => {} };
      web.swapTo = jest.fn((...args: unknown[]) => {
        swap.switched = args[5] as () => void;
        return new Promise<SwapOutcome>((resolve) => (swap.swapped = resolve));
      });
      return swap;
    }

    it("reads the stream's own move to its next file as the stream's while the copy buffers", async () => {
      // 20 s into 2.mp3 (index 0); the download holds it at index 1, after c.mp3.
      const swap = bufferingSwap();
      await streamIn(newOrder);
      downloadLands(withExtra);
      await flushMicrotasks();
      // The stream plays on into 10.mp3 (its index 1), which the download holds at 2: read
      // through the download's queue it would be 2.mp3 again, 3 s in.
      pushSnapshot(snap('playing', 3, { trackIndex: 1, duration: 30 }));
      expect(selectBookPosition(usePlayer.getState())).toBe(73);
      // The engine refuses the swap (the copy never became playable): the place saves as it is.
      swap.swapped('refused');
      await flushMicrotasks();
      pushSnapshot(snap('paused', 4, { trackIndex: 1, duration: 30 }));
      await flushMicrotasks();
      expect(savedPositions()).toEqual([74]);
    });

    it("reads the copy's index onto the stream's queue from the switch to the commit", async () => {
      const swap = bufferingSwap();
      await streamIn(newOrder);
      downloadLands(withExtra);
      await flushMicrotasks();
      swap.switched();
      // The engine is on the copy: its index 1 is 2.mp3, the stream's index 0.
      pushSnapshot(snap('playing', 21, { trackIndex: 1, duration: 70 }));
      expect(selectBookPosition(usePlayer.getState())).toBe(21);
      swap.swapped('swapped');
      await flushMicrotasks();
      expect(queueUrls()).toEqual(withExtra.map(urlOf));
      expect(selectBookPosition(usePlayer.getState())).toBe(71); // c.mp3's 50 + 21
    });

    /** Each swap still buffering, in turn: answer the nth with `answers[n]`. */
    function swapsInTurn() {
      const answers: ((outcome: SwapOutcome) => void)[] = [];
      web.swapTo = jest.fn(() => new Promise<SwapOutcome>((resolve) => void answers.push(resolve)));
      return answers;
    }

    it('swaps again from where a seek made while the copy buffered put the listener', async () => {
      const answers = swapsInTurn();
      await streamIn(newOrder);
      downloadLands(oldOrder);
      await flushMicrotasks();
      expect(startOf(web.swapTo!.mock.calls[0])).toMatchObject({ index: 0, position: 20 });
      // The listener seeks to 45 s while the copy buffers at 20 s: the engine refuses it.
      pushSnapshot(snap('playing', 45, { trackIndex: 0, duration: 70 }));
      answers[0]('moved');
      await flushMicrotasks();
      expect(web.swapTo).toHaveBeenCalledTimes(2);
      expect(startOf(web.swapTo!.mock.calls[1])).toEqual({
        url: urlOf('A/Folder/2.mp3'),
        index: 0,
        position: 45,
      });
      answers[1]('swapped');
      await flushMicrotasks();
      expect(queueUrls()).toEqual(newOrder.map(urlOf));
      expect(selectBookPosition(usePlayer.getState())).toBe(45);
    });

    it('swaps in at the last seek after seeks in successive buffering windows', async () => {
      const answers = swapsInTurn();
      await streamIn(newOrder);
      downloadLands(oldOrder);
      await flushMicrotasks();
      pushSnapshot(snap('playing', 45, { trackIndex: 0, duration: 70 }));
      answers[0]('moved');
      await flushMicrotasks();
      // A second seek while the retry's copy buffers: a third attempt from there.
      pushSnapshot(snap('playing', 10, { trackIndex: 0, duration: 70 }));
      answers[1]('moved');
      await flushMicrotasks();
      expect(web.swapTo).toHaveBeenCalledTimes(3);
      expect(startOf(web.swapTo!.mock.calls[2])).toEqual({
        url: urlOf('A/Folder/2.mp3'),
        index: 0,
        position: 10,
      });
      answers[2]('swapped');
      await flushMicrotasks();
      expect(queueUrls()).toEqual(newOrder.map(urlOf));
      expect(selectBookPosition(usePlayer.getState())).toBe(10);
    });

    it("swaps again from the next file the stream's own advance moved it to", async () => {
      const answers = swapsInTurn();
      await streamIn(newOrder);
      downloadLands(oldOrder);
      await flushMicrotasks();
      // 2.mp3 ends while the copy buffers: the stream moves on into 10.mp3 by itself.
      pushSnapshot(snap('playing', 0, { trackIndex: 1, duration: 30 }));
      answers[0]('moved');
      await flushMicrotasks();
      expect(web.swapTo).toHaveBeenCalledTimes(2);
      expect(startOf(web.swapTo!.mock.calls[1])).toEqual({
        url: urlOf('A/Folder/10.mp3'),
        index: 1,
        position: 0,
      });
      answers[1]('swapped');
      await flushMicrotasks();
      expect(queueUrls()).toEqual(newOrder.map(urlOf));
    });

    it('does not swap again once the download was removed while the copy buffered', async () => {
      const answers = swapsInTurn();
      await streamIn(newOrder);
      downloadLands(oldOrder);
      await flushMicrotasks();
      pushSnapshot(snap('playing', 45, { trackIndex: 0, duration: 70 }));
      useDownloads.setState({ entries: {} });
      answers[0]('moved');
      await flushMicrotasks();
      expect(web.swapTo).toHaveBeenCalledTimes(1);
      expect(queueUrls()?.[0]).toBe('stream:2:A/Folder/2.mp3');
    });

    it('does not swap again after a stop while the copy buffered', async () => {
      const answers = swapsInTurn();
      await streamIn(newOrder);
      downloadLands(oldOrder);
      await flushMicrotasks();
      await usePlayer.getState().stop();
      answers[0]('moved');
      await flushMicrotasks();
      expect(web.swapTo).toHaveBeenCalledTimes(1);
      expect(usePlayer.getState().nowPlaying).toBeNull();
    });

    it('does not swap again once another book started while the copy buffered', async () => {
      const answers = swapsInTurn();
      await streamIn(newOrder);
      downloadLands(oldOrder);
      await flushMicrotasks();
      const other = makeBook({ rel_path: 'Other/Book', title: 'Other' });
      await usePlayer.getState().playBook('c1', 2, other, undefined, 0);
      answers[0]('moved');
      await flushMicrotasks();
      expect(web.swapTo).toHaveBeenCalledTimes(1);
      expect(usePlayer.getState().nowPlaying?.path).toBe('Other/Book');
    });
  });
});

// --- offline playback of a downloaded book whose connection is gone ----------------
// A connection whose secure-store token fails to hydrate is dropped from the session, so
// resolveClient() returns null - but downloads.hydrate keeps its entry. A fully-local
// book needs no server, so playBook must still play it.

describe('plays a downloaded book whose connection is gone', () => {
  function seedDownloaded(cid: string) {
    const manifest: DownloadManifest = {
      book: makeBook(),
      chapters: null,
      files: [{ relPath: 'A/Book.m4b', localUri: 'file:///dl/0.m4b' }],
      coverUri: 'file:///dl/cover.jpg',
      savedAt: '2026-01-01T00:00:00Z',
    };
    const entry: DownloadEntry = {
      connectionId: cid,
      libraryId: 2,
      path: 'A/Book.m4b',
      title: 'A Book',
      status: 'downloaded',
      progress: 1,
      bytes: 0,
      totalBytes: 0,
      manifest,
    };
    useDownloads.setState({ entries: { [`${cid}:2:A/Book.m4b`]: entry } });
  }

  it('loads the local files (not a stream URL) when resolveClient returns null', async () => {
    seedDownloaded('gone');
    mockResolveClient.mockReturnValueOnce(null); // connection dropped from the session
    (mockSvc.load as jest.Mock).mockClear();

    await usePlayer.getState().playBook('gone', 2, makeBook(), undefined);

    // It did NOT bail: the engine loaded the book, pointing at the local file.
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    const tracks = (mockSvc.load as jest.Mock).mock.calls[0][0] as { url: string }[];
    expect(tracks[0].url).toBe('file:///dl/0.m4b');
    // nowPlaying is set, scoped to the (missing) connection, with the downloaded cover.
    expect(usePlayer.getState().nowPlaying?.connectionId).toBe('gone');
    expect(usePlayer.getState().nowPlaying?.cover).toBe('file:///dl/cover.jpg');
  });

  // v2.5.1 PLAYER-01: the mirror holds the server's place from the download, so the
  // lookup answers `progress` offline and the book starts there, not at 0.
  it('starts a downloaded book at its kept place offline', async () => {
    seedDownloaded('c1');
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'progress',
      progress: makeProgress({ position: 70, duration: 100 }),
    });
    (mockSvc.load as jest.Mock).mockClear();

    await usePlayer.getState().playBook('c1', 2, makeBook(), undefined);

    const [tracks, , position] = (mockSvc.load as jest.Mock).mock.calls[0];
    expect((tracks as { url: string }[])[0].url).toBe('file:///dl/0.m4b');
    expect(position).toBe(70);
  });

  it('saves nothing while the connection is gone, then saves once it is back', async () => {
    // A session that could not be read yet (a CarPlay launch with the phone locked) loads
    // its connections later, while the downloaded book plays on.
    seedDownloaded('gone');
    mockResolveClient.mockReturnValue(null);
    try {
      await usePlayer.getState().playBook('gone', 2, makeBook(), undefined);
      mockSaveProgress.mockClear();
      (writeMirror as jest.Mock).mockClear();
      pushSnapshot(snap('playing', 40));
      pushSnapshot(snap('paused', 40));
      await flushMicrotasks();
      expect(mockSaveProgress).not.toHaveBeenCalled();
      // This device's record still keeps the place (fe#265): an offline Resume reads it.
      expect(writeMirror).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: 'gone', position: 40 }),
      );
    } finally {
      mockResolveClient.mockReturnValue(fakeClient);
    }
    pushSnapshot(snap('playing', 50));
    pushSnapshot(snap('paused', 50));
    await flushMicrotasks();
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][0]).toBe(fakeClient);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({
      connectionId: 'gone',
      position: 50,
    });
  });

  // The device run: a frozen server held a downloaded book's car start for its whole request
  // timeout, past the car's 10 s wait, and the book loaded paused.
  it("waits on its server's place only briefly, and not at all when it is unreachable", async () => {
    seedDownloaded('c1');
    try {
      await usePlayer.getState().playBook('c1', 2, makeBook(), undefined);
      expect(mockLoadInitialProgress).toHaveBeenLastCalledWith(
        fakeClient,
        'c1',
        2,
        'A/Book.m4b',
        DOWNLOADED_PLACE_WAIT_MS,
      );
      useReachability.setState({ online: { c1: false } });
      await usePlayer.getState().playBook('c1', 2, makeBook(), undefined);
      expect(mockLoadInitialProgress).toHaveBeenLastCalledWith(
        null,
        'c1',
        2,
        'A/Book.m4b',
        DOWNLOADED_PLACE_WAIT_MS,
      );
    } finally {
      useReachability.setState({ online: {} });
    }
  });

  it('a streamed book still waits for its server (its place has nowhere else to come from)', async () => {
    useReachability.setState({ online: { c1: false } });
    try {
      await usePlayer.getState().playBook('c1', 2, makeBook(), undefined);
      expect(mockLoadInitialProgress).toHaveBeenLastCalledWith(
        fakeClient,
        'c1',
        2,
        'A/Book.m4b',
        undefined,
      );
    } finally {
      useReachability.setState({ online: {} });
    }
  });

  it('still bails when the connection is gone AND the book is not downloaded (streaming needs a client)', async () => {
    mockResolveClient.mockReturnValueOnce(null);
    (mockSvc.load as jest.Mock).mockClear();

    await usePlayer.getState().playBook('gone', 2, makeBook(), undefined);

    // No local files + no client => nothing to play; the online/streaming path is unchanged.
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying).toBeNull();
  });
});

// --- web transcode negotiation (playBook decides; retry reuses the queue) ---------

describe('web transcode negotiation', () => {
  const prevOS = Platform.OS;
  const undecodable = () => makeBook({ direct_playable: false, codec: 'ac3' });
  const loadedTracks = () =>
    (mockSvc.load as jest.Mock).mock.calls[0][0] as { url: string; transcoded?: boolean }[];

  beforeEach(() => {
    Platform.OS = 'web';
    mockFetchQuery.mockResolvedValue({ capabilities: { transcode: true } });
    (mockSvc.load as jest.Mock).mockClear();
  });
  afterEach(() => {
    Platform.OS = prevOS;
  });

  it('streams an undecodable book transcoded on web when its server can', async () => {
    await startBook(undecodable(), 0);
    expect(loadedTracks()[0]).toMatchObject({
      url: 'stream:2:A/Book.m4b:transcode',
      transcoded: true,
    });
  });

  it('streams directly when the server has no transcoder, or its /server read fails', async () => {
    mockFetchQuery.mockResolvedValueOnce({ capabilities: { transcode: false } });
    await startBook(undecodable(), 0);
    expect(loadedTracks()[0].url).toBe('stream:2:A/Book.m4b');
    expect(loadedTracks()[0].transcoded).toBeUndefined();

    (mockSvc.load as jest.Mock).mockClear();
    mockFetchQuery.mockRejectedValueOnce(new Error('offline'));
    await startBook(undecodable(), 0);
    expect(loadedTracks()[0].url).toBe('stream:2:A/Book.m4b');
  });

  it('never asks for a direct-playable book, or off web', async () => {
    await startBook(makeBook({ direct_playable: true }), 0);
    expect(loadedTracks()[0].url).toBe('stream:2:A/Book.m4b');
    Platform.OS = 'ios';
    (mockSvc.load as jest.Mock).mockClear();
    await startBook(undecodable(), 0);
    expect(loadedTracks()[0].url).toBe('stream:2:A/Book.m4b');
    expect(mockFetchQuery).not.toHaveBeenCalled();
  });

  it('retry reloads the same transcoded tracks at the track-absolute position', async () => {
    await startBook(undecodable(), 0);
    pushSnapshot(snap('playing', 42));
    await Promise.resolve();
    pushSnapshot(snap('error', 42));
    await Promise.resolve();
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().retry();
    expect(loadedTracks()[0].transcoded).toBe(true);
    // The engine re-requests at this position (`&t=42`, see service.web.test.ts).
    expect((mockSvc.load as jest.Mock).mock.calls[0][2]).toBe(42);
  });
});

// --- finishBook (mark the current book finished) -----------------------------

describe('finishBook', () => {
  function downloadedEntry(): DownloadEntry {
    const manifest: DownloadManifest = {
      book: makeBook(),
      chapters: null,
      files: [{ relPath: 'A/Book.m4b', localUri: 'file:///dl/0.m4b' }],
      coverUri: null,
      savedAt: '2026-01-01T00:00:00Z',
    };
    return {
      connectionId: 'c1',
      libraryId: 2,
      path: 'A/Book.m4b',
      title: 'A Book',
      status: 'downloaded',
      progress: 1,
      bytes: 0,
      totalBytes: 0,
      manifest,
    };
  }

  it('persists finished:true, returns the book identity, and clears nowPlaying', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 40)); // mid-book: proves finished is forced, not tolerance
    await Promise.resolve();

    mockSaveProgress.mockClear();
    const info = usePlayer.getState().finishBook();
    await Promise.resolve();
    await Promise.resolve();

    expect(info).toMatchObject({ connectionId: 'c1', libraryId: 2, path: 'A/Book.m4b' });
    expect(mockSaveProgress).toHaveBeenCalledTimes(1);
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ finished: true });
    expect(usePlayer.getState().nowPlaying).toBeNull();
  });

  it('invalidates the progress lists AND the finished book own progress key', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 40));
    await Promise.resolve();
    (queryClient.invalidateQueries as jest.Mock).mockClear();

    usePlayer.getState().finishBook();
    await flushMicrotasks();

    expect(invalidatedKeys()).toContainEqual(qk.allProgress('c1'));
    expect(invalidatedKeys()).toContainEqual(qk.progress('c1', 2, 'A/Book.m4b'));
  });

  it('returns null when nothing is playing', () => {
    expect(usePlayer.getState().finishBook()).toBeNull();
  });

  it('deletes the downloaded copy when autoDeleteFinished is on', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 40));
    await Promise.resolve();

    useDownloads.setState({ entries: { 'c1:2:A/Book.m4b': downloadedEntry() } });
    const removeSpy = jest.spyOn(useDownloads.getState(), 'remove').mockResolvedValue(undefined);
    useSettings.setState({ autoDeleteFinished: true });

    usePlayer.getState().finishBook();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(removeSpy).toHaveBeenCalledWith('c1', 2, 'A/Book.m4b');
    removeSpy.mockRestore();
  });

  // fe#166 (D4): one setting for books and episodes.
  it('deletes a downloaded episode when autoDeleteFinished is on', async () => {
    const episode = makeEpisode();
    await startBook(episode, 0);
    pushSnapshot(snap('playing', 40));
    await Promise.resolve();

    const entry = downloadedEntry();
    useDownloads.setState({
      entries: {
        'c1:2:Show/Ep.mp3': {
          ...entry,
          path: 'Show/Ep.mp3',
          manifest: {
            ...entry.manifest,
            book: episode,
            files: [{ relPath: 'Show/Ep.mp3', localUri: 'file:///dl/0.mp3' }],
          },
        },
      },
    });
    const removeSpy = jest.spyOn(useDownloads.getState(), 'remove').mockResolvedValue(undefined);
    useSettings.setState({ autoDeleteFinished: true });

    expect(usePlayer.getState().finishBook()).toMatchObject({ episode: true });
    await flushMicrotasks();

    expect(removeSpy).toHaveBeenCalledWith('c1', 2, 'Show/Ep.mp3');
    removeSpy.mockRestore();
  });

  it('keeps the downloaded copy when autoDeleteFinished is off', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 40));
    await Promise.resolve();

    useDownloads.setState({ entries: { 'c1:2:A/Book.m4b': downloadedEntry() } });
    const removeSpy = jest.spyOn(useDownloads.getState(), 'remove').mockResolvedValue(undefined);
    useSettings.setState({ autoDeleteFinished: false });

    usePlayer.getState().finishBook();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(removeSpy).not.toHaveBeenCalled();
    removeSpy.mockRestore();
    useSettings.setState({ autoDeleteFinished: true }); // restore the default
  });
});

// --- auto-download the book you start listening to ---------------------------
// playBook fires this fire-and-forget AFTER playback is initiated: download the started
// book (per the autoDownloadNext setting + network policy) unless it's already downloaded/
// queued. The player then hot-swaps to the local copy when the download completes.

describe('auto-download on start', () => {
  const GB = 1024 ** 3;
  // Plenty of room unless a case says otherwise (the engine's own answer depends on the
  // test environment's file-system mock).
  let estimateSpy: jest.SpyInstance;
  beforeEach(() => {
    estimateSpy = jest
      .spyOn(downloadEngine, 'storageEstimate')
      .mockResolvedValue({ scope: 'device', capacity: 64 * GB, free: 40 * GB });
  });
  afterEach(() => estimateSpy.mockRestore());

  // The origin is the regression test for the bug where it asked as the listener (the
  // default origin), which lifts a decline mark as if the listener had chosen it.
  it('downloads the started book as an automatic download when the mode allows it', async () => {
    useSettings.setState({ autoDownloadNext: 'wifi' });
    mockCanAutoDownload.mockResolvedValue(true);
    const downloadSpy = jest
      .spyOn(useDownloads.getState(), 'download')
      .mockImplementation(async () => 'queued');

    // A path no earlier test removed (the session decline mark is module state).
    const book = makeBook({ rel_path: 'A/Fresh.m4b' });
    await startBook(book, 0);
    await flushMicrotasks(); // let the fire-and-forget network and room checks resolve

    expect(mockCanAutoDownload).toHaveBeenCalledWith('wifi');
    expect(downloadSpy).toHaveBeenCalledWith('c1', 2, book, undefined, 'auto');
    downloadSpy.mockRestore();
  });

  // fe#166 (D4b): an episode only with "Download podcast episodes when you start them" on
  // (off by default), under the books' network rule.
  describe('a podcast episode', () => {
    afterEach(() => useSettings.setState({ autoDownloadEpisodes: false }));

    it('is skipped with the episodes setting off (the default)', async () => {
      useSettings.setState({ autoDownloadNext: 'always', autoDownloadEpisodes: false });
      const downloadSpy = jest
        .spyOn(useDownloads.getState(), 'download')
        .mockImplementation(async () => 'queued');
      await startBook(makeEpisode(), 0);
      await flushMicrotasks();
      expect(downloadSpy).not.toHaveBeenCalled();
      downloadSpy.mockRestore();
    });

    it('downloads on Wi-Fi with it on, as an automatic download', async () => {
      useSettings.setState({ autoDownloadNext: 'wifi', autoDownloadEpisodes: true });
      mockCanAutoDownload.mockResolvedValue(true);
      const downloadSpy = jest
        .spyOn(useDownloads.getState(), 'download')
        .mockImplementation(async () => 'queued');
      const episode = makeEpisode();
      await startBook(episode, 0);
      await flushMicrotasks();
      expect(mockCanAutoDownload).toHaveBeenCalledWith('wifi');
      expect(downloadSpy).toHaveBeenCalledWith('c1', 2, episode, undefined, 'auto');
      downloadSpy.mockRestore();
    });

    it('never on mobile data when the rule says Wi-Fi only', async () => {
      useSettings.setState({ autoDownloadNext: 'wifi', autoDownloadEpisodes: true });
      mockCanAutoDownload.mockResolvedValue(false);
      const downloadSpy = jest
        .spyOn(useDownloads.getState(), 'download')
        .mockImplementation(async () => 'queued');
      await startBook(makeEpisode(), 0);
      await flushMicrotasks();
      expect(downloadSpy).not.toHaveBeenCalled();
      downloadSpy.mockRestore();
    });

    it("never when the books' rule is Never", async () => {
      useSettings.setState({ autoDownloadNext: 'never', autoDownloadEpisodes: true });
      const downloadSpy = jest
        .spyOn(useDownloads.getState(), 'download')
        .mockImplementation(async () => 'queued');
      await startBook(makeEpisode(), 0);
      await flushMicrotasks();
      expect(downloadSpy).not.toHaveBeenCalled();
      downloadSpy.mockRestore();
    });
  });

  it("does not download when the mode is 'never'", async () => {
    useSettings.setState({ autoDownloadNext: 'never' });
    const downloadSpy = jest
      .spyOn(useDownloads.getState(), 'download')
      .mockImplementation(async () => 'queued');

    await startBook(makeBook(), 0);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCanAutoDownload).not.toHaveBeenCalled();
    expect(downloadSpy).not.toHaveBeenCalled();
    downloadSpy.mockRestore();
  });

  it('does not download a book that is already downloaded', async () => {
    useSettings.setState({ autoDownloadNext: 'always' });
    const book = makeBook();
    const manifest: DownloadManifest = {
      book,
      chapters: null,
      files: [{ relPath: book.rel_path, localUri: 'file:///dl/0.m4b' }],
      coverUri: null,
      savedAt: '2026-01-01T00:00:00Z',
    };
    const entry: DownloadEntry = {
      connectionId: 'c1',
      libraryId: 2,
      path: book.rel_path,
      title: book.title,
      status: 'downloaded',
      progress: 1,
      bytes: 0,
      totalBytes: 0,
      manifest,
    };
    useDownloads.setState({ entries: { [`c1:2:${book.rel_path}`]: entry } });
    const downloadSpy = jest
      .spyOn(useDownloads.getState(), 'download')
      .mockImplementation(async () => 'queued');

    await startBook(book, 0);
    await Promise.resolve();
    await Promise.resolve();

    expect(downloadSpy).not.toHaveBeenCalled();
    downloadSpy.mockRestore();
  });

  // Phase 3 (decision 7: each store change has its own regression test). The rules live
  // in the downloads store's `download()` (automatic origins); these prove the book you
  // start goes through them, against the real downloads store.
  describe('respects the session decline mark and the keep-ahead reserve', () => {
    let fileSpy: jest.SpyInstance;
    beforeEach(() => {
      useSettings.setState({ autoDownloadNext: 'always' });
      // The queue may run; no file is fetched.
      fileSpy = jest
        .spyOn(downloadEngine, 'downloadFile')
        .mockRejectedValue(new Error('offline in tests'));
    });
    afterEach(() => fileSpy.mockRestore());

    const entryOf = (book: Book) => useDownloads.getState().entries[`c1:2:${book.rel_path}`];
    async function startAndSettle(book: Book) {
      await startBook(book, 0);
      await flushMicrotasks(12);
    }

    it('skips a book the listener removed this session, and leaves the mark in place', async () => {
      const book = makeBook();
      await useDownloads.getState().remove('c1', 2, book.rel_path);
      expect(isDeclined('c1', 2, book.rel_path)).toBe(true);
      await startAndSettle(book);
      // Declined: no download, and the mark stays (an `auto` ask never lifts it).
      expect(entryOf(book)).toBeUndefined();
      expect(isDeclined('c1', 2, book.rel_path)).toBe(true);
    });

    it('skips a book whose download the listener cancelled this session', async () => {
      const book = makeBook({ rel_path: 'A/Cancelled.m4b' });
      useDownloads.getState().cancel('c1', 2, book.rel_path);
      await startAndSettle(book);
      expect(entryOf(book)).toBeUndefined();
    });

    it('skips a book that would leave less than the reserve free', async () => {
      // 64 GB disk: the reserve is 6.4 GB; 8 GB free leaves 1.6 GB of room.
      estimateSpy.mockResolvedValue({ scope: 'device', capacity: 64 * GB, free: 8 * GB });
      const book = makeBook({ rel_path: 'A/Big.m4b', size: 2 * GB });
      await startAndSettle(book);
      expect(entryOf(book)).toBeUndefined();

      // The same book fits once there is room for it.
      estimateSpy.mockResolvedValue({ scope: 'device', capacity: 64 * GB, free: 9 * GB });
      await usePlayer.getState().stop();
      await startAndSettle(book);
      expect(entryOf(book)?.origin).toBe('auto');
    });

    it('downloads when the room is not knowable, as keep-ahead starts one', async () => {
      estimateSpy.mockResolvedValue(null);
      const book = makeBook({ rel_path: 'A/Any.m4b', size: 50 * GB });
      await startAndSettle(book);
      expect(entryOf(book)?.origin).toBe('auto');
    });
  });
});

// --- the output gain the engine is already at ------------------------------

describe('setOutputVolume', () => {
  it('writes a changed gain and skips one that would change nothing', async () => {
    await startBook();
    // playBook re-asserts full volume on the engine as its own backstop; the gain the
    // store remembers has to move with it, or a real restore later would be dropped.
    const setVolume = mockSvc.setVolume as jest.Mock;
    setVolume.mockClear();

    await usePlayer.getState().setOutputVolume(0.5);
    await usePlayer.getState().setOutputVolume(0.5); // the sleep timer's 4Hz fade re-writes
    expect(setVolume).toHaveBeenCalledTimes(1);
    expect(setVolume).toHaveBeenLastCalledWith(0.5);

    // The restore is a real change, so it is never the one that gets skipped - a
    // listener left with a quiet book is this feature's worst failure.
    await usePlayer.getState().setOutputVolume(1);
    expect(setVolume).toHaveBeenCalledTimes(2);
    expect(setVolume).toHaveBeenLastCalledWith(1);
  });

  it('re-asserts full volume only once the new book is the one playing', async () => {
    const setVolume = mockSvc.setVolume as jest.Mock;
    await startBook(makeBook({ rel_path: 'A/First.m4b' }), 0);

    // Which book was loaded at the moment each gain reached the engine. The sleep timer's
    // 250ms fade ticker cancels itself by comparing the PLAYING book with the timer's
    // own, so a backstop written while `nowPlaying` still holds the old book is one the
    // ticker is still entitled to overwrite - and the resume lookup below it is a network
    // round trip, far longer than the fade's period. The new book could start attenuated.
    const seen: (string | null)[] = [];
    setVolume.mockClear();
    setVolume.mockImplementation(async () => {
      seen.push(usePlayer.getState().nowPlaying?.path ?? null);
    });
    // No explicit start position, so this takes the resume-lookup path a real play uses.
    await usePlayer.getState().playBook('c1', 2, makeBook({ rel_path: 'A/Second.m4b' }));

    expect(seen).toEqual(['A/Second.m4b']);
    setVolume.mockImplementation(async () => {});
  });

  it('clamps out-of-range gains before comparing', async () => {
    await startBook();
    const setVolume = mockSvc.setVolume as jest.Mock;
    setVolume.mockClear();
    await usePlayer.getState().setOutputVolume(3); // clamps to 1, which it is already at
    expect(setVolume).not.toHaveBeenCalled();
    await usePlayer.getState().setOutputVolume(-1); // clamps to 0
    expect(setVolume).toHaveBeenLastCalledWith(0);
    // ...and back to full for the tests that follow (the gain is module state).
    await usePlayer.getState().setOutputVolume(1);
  });
});

// --- files of unknown length (fe#324) -----------------------------------------

describe('a book whose files have no known length', () => {
  const files = ['A/Unknown/01.mp3', 'A/Unknown/02.mp3'];
  const chapters: ChaptersResponse = {
    library_id: 2,
    path: 'A/Unknown',
    duration: 0,
    is_folder: true,
    files: files.map((rel_path, seq) => ({ rel_path, seq, duration: 0, format: 'mp3', size: 1 })),
    chapters: files.map((file_path, index) => ({
      index,
      title: `Part ${index + 1}`,
      file_index: index,
      file_path,
      start: 0,
      end: 0,
      book_offset: 0,
    })),
  };
  const book = makeBook({ rel_path: 'A/Unknown', is_folder: true, format: 'mp3', duration: 0 });

  it('starts in the first file and names the chapter of the file playing', async () => {
    await usePlayer.getState().playBook('c1', 2, book, chapters, 0);
    const [, index, position] = (mockSvc.load as jest.Mock).mock.lastCall as unknown[];
    expect([index, position]).toEqual([0, 0]);

    pushSnapshot(snap('playing', 12, { trackIndex: 0 }));
    expect(selectCurrentChapter(usePlayer.getState())?.title).toBe('Part 1');
    pushSnapshot(snap('playing', 0, { trackIndex: 1 }));
    expect(selectCurrentChapter(usePlayer.getState())?.title).toBe('Part 2');
    pushSnapshot(snap('playing', 30, { trackIndex: 1 }));
    expect(selectCurrentChapter(usePlayer.getState())?.title).toBe('Part 2');
  });

  it("a skip on the book in error keeps the engine's length of the file", async () => {
    await usePlayer.getState().playBook('c1', 2, book, chapters, 0);
    pushSnapshot(snap('playing', 30, { trackIndex: 1, duration: 300 }));
    pushSnapshot(snap('error', 30, { trackIndex: 1, duration: 300 }));
    await flushMicrotasks();
    await usePlayer.getState().skipSeconds(10);
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 1,
      position: 40,
      duration: 300,
    });
  });

  it('retries in the file that failed, not the first', async () => {
    await usePlayer.getState().playBook('c1', 2, book, chapters, 0);
    pushSnapshot(snap('error', 30, { trackIndex: 1 }));
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().retry();
    const [, index, position] = (mockSvc.load as jest.Mock).mock.lastCall as unknown[];
    expect([index, position]).toEqual([1, 30]);
  });

  it('retries from a download that landed meanwhile in the file that failed (fe#278)', async () => {
    const web = mockSvc as unknown as { swapTo?: jest.Mock };
    web.swapTo = jest.fn(async () => 'refused');
    try {
      await usePlayer.getState().playBook('c1', 2, book, chapters, 0);
      pushSnapshot(snap('error', 30, { trackIndex: 1 }));
      await flushMicrotasks();
      useDownloads.setState({
        entries: {
          'c1:2:A/Unknown': {
            connectionId: 'c1',
            libraryId: 2,
            path: 'A/Unknown',
            title: book.title,
            status: 'downloaded',
            progress: 1,
            bytes: 0,
            totalBytes: 0,
            manifest: {
              book,
              chapters,
              files: files.map((relPath) => ({ relPath, localUri: `file:///dl/${relPath}` })),
              coverUri: null,
              savedAt: '2026-01-01T00:00:00Z',
            },
          },
        },
      });
      await flushMicrotasks();
      (mockSvc.load as jest.Mock).mockClear();
      await usePlayer.getState().retry();
      const [tracks, index, position] = (mockSvc.load as jest.Mock).mock.lastCall as [
        { url: string }[],
        number,
        number,
      ];
      expect([tracks[index].url, index, position]).toEqual([`file:///dl/${files[1]}`, 1, 30]);
    } finally {
      delete web.swapTo;
    }
  });
});

// An engine that measured a file short: Android's Media3 read a VBR MP3 with no seek header
// (139.42 s on the server) as 29.889 s from its first frame. A resume past that landed in the
// next file, and a Retry there ended, and finished, the book.
describe('an engine that measured a file short (a VBR MP3 with no seek header)', () => {
  const files = ['A/Vbr/01.mp3', 'A/Vbr/02.mp3'];
  const lengths = [139.42, 138.69];
  const chapters: ChaptersResponse = {
    library_id: 2,
    path: 'A/Vbr',
    duration: 278.11,
    is_folder: true,
    files: files.map((rel_path, seq) => ({
      rel_path,
      seq,
      duration: lengths[seq],
      format: 'mp3',
      size: 1,
    })),
    chapters: files.map((file_path, index) => ({
      index,
      title: `Part ${index + 1}`,
      file_index: index,
      file_path,
      start: 0,
      end: lengths[index],
      book_offset: index === 0 ? 0 : lengths[0],
    })),
  };
  const book = makeBook({ rel_path: 'A/Vbr', is_folder: true, format: 'mp3', duration: 278.11 });
  const short = 29.889;
  const resume = (at: number) => usePlayer.getState().playBook('c1', 2, book, chapters, at);
  const savedFinished = () =>
    mockSaveProgress.mock.calls.some((c) => (c[1] as { finished: boolean }).finished);
  const lastLoad = () => ((mockSvc.load as jest.Mock).mock.lastCall as unknown[]).slice(1, 3);
  /** The engine ran off its 29.9 s of file 1 into file 2, and no move of the listener's came. */
  const ranOff = () => {
    pushSnapshot(snap('playing', 0.4, { trackIndex: 1, duration: short }));
    jest.advanceTimersByTime(FAULT_HOLD_MS);
  };

  it("reads a file's length as the server's where the engine measured it short", async () => {
    await resume(30);
    pushSnapshot(snap('playing', 31.5, { trackIndex: 0, duration: short }));
    expect(usePlayer.getState().snapshot.duration).toBe(139.42);
    // Within the tolerance the engine's own stands.
    pushSnapshot(snap('playing', 32.5, { trackIndex: 0, duration: 138 }));
    expect(usePlayer.getState().snapshot.duration).toBe(138);
    // So a seek past the short measure is not clamped to it.
    pushSnapshot(snap('playing', 33.5, { trackIndex: 0, duration: short }));
    await usePlayer.getState().seekInTrack(100);
    expect(mockSvc.seekTo).toHaveBeenLastCalledWith(100);
  });

  it('a resume that lands in the next file stops there as an error, at the resumed place', async () => {
    await resume(30);
    expect(lastLoad()).toEqual([0, 30]);
    ranOff();
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 30,
      duration: 139.42,
    });
    expect(mockSvc.pause).toHaveBeenCalled();
    // A play the engine makes by itself is not taken, and is stopped again.
    (mockSvc.pause as jest.Mock).mockClear();
    pushSnapshot(snap('playing', 1.4, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', trackIndex: 0 });
    expect(mockSvc.pause).toHaveBeenCalled();
    // Nothing past the resumed place is ever saved.
    expect(savedPositions().every((p) => p <= 30)).toBe(true);
  });

  it('a press on the stopped book reloads it at its place, never resumes the engine', async () => {
    await resume(30);
    ranOff();
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    (mockSvc.play as jest.Mock).mockClear();
    await usePlayer.getState().toggle();
    expect(lastLoad()).toEqual([0, 30]);
  });

  it('a file played on from the resumed place goes on into the next one', async () => {
    await resume(30);
    pushSnapshot(snap('playing', 31.5, { trackIndex: 0 }));
    pushSnapshot(snap('playing', 139, { trackIndex: 0 }));
    pushSnapshot(snap('playing', 0.4, { trackIndex: 1 }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', trackIndex: 1 });
  });

  it("the listener's own move to the next file from the lock screen is no fault", async () => {
    await resume(30);
    await usePlayer.getState().pause();
    pushSnapshot(snap('paused', 30, { trackIndex: 0 }));
    // Paused, the lock screen's next chapter: the file changes first, then the move lands.
    pushSnapshot(snap('paused', 0, { trackIndex: 1 }));
    remoteMove!(1, 0);
    pushSnapshot(snap('playing', 0.5, { trackIndex: 1 }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', trackIndex: 1 });
  });

  it("an end of the media short of the book's end never finishes it", async () => {
    // Resumed 89.9 s into file 2, which the engine measured at 29.9 s: it ends at once.
    await resume(lengths[0] + 89.898);
    mockSaveProgress.mockClear();
    pushSnapshot(snap('playing', 89.9, { trackIndex: 1, duration: short }));
    pushSnapshot(snap('ended', short, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 1,
      position: 89.898,
    });
    expect(selectIsEnded(usePlayer.getState())).toBe(false);
    expect(savedFinished()).toBe(false);
  });

  it("a Retry's end at once, short of the book's end, never finishes it", async () => {
    await resume(lengths[0] + 89.898);
    pushSnapshot(snap('playing', 89.9, { trackIndex: 1, duration: short }));
    pushSnapshot(snap('ended', short, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    mockSaveProgress.mockClear();
    await usePlayer.getState().retry();
    pushSnapshot(snap('playing', 89.9, { trackIndex: 1, duration: short }));
    pushSnapshot(snap('ended', short, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 89.898 });
    expect(selectIsEnded(usePlayer.getState())).toBe(false);
    expect(savedFinished()).toBe(false);
  });

  it("an end after playing on is the book's, though short of the server's length", async () => {
    // The server's ffprobe estimate overestimated the last file: the audio ends at 120 s.
    await resume(lengths[0] + 60);
    pushSnapshot(snap('playing', 61, { trackIndex: 1 }));
    pushSnapshot(snap('playing', 64, { trackIndex: 1 }));
    mockSaveProgress.mockClear();
    pushSnapshot(snap('ended', 120, { trackIndex: 1 }));
    await flushMicrotasks();
    expect(selectIsEnded(usePlayer.getState())).toBe(true);
  });

  it("an end with no play since a seek past the engine's end never finishes the book", async () => {
    await resume(lengths[0] + 60);
    pushSnapshot(snap('playing', 64, { trackIndex: 1, duration: 100 }));
    await usePlayer.getState().seekInTrack(130);
    expect(mockSvc.seekTo).toHaveBeenLastCalledWith(130);
    mockSaveProgress.mockClear();
    pushSnapshot(snap('ended', 100, { trackIndex: 1, duration: 100 }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 1,
      position: 130,
    });
    expect(selectIsEnded(usePlayer.getState())).toBe(false);
    expect(savedFinished()).toBe(false);
  });

  it("a resume near a file's end plays on into the next file and to its end", async () => {
    // Within the tolerance of file 1's end: the move on is no fault, and the play from there
    // makes the end the book's.
    await resume(137);
    pushSnapshot(snap('playing', 139, { trackIndex: 0 }));
    pushSnapshot(snap('playing', 0.5, { trackIndex: 1 }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', trackIndex: 1 });
    pushSnapshot(snap('playing', 120, { trackIndex: 1 }));
    pushSnapshot(snap('ended', 125, { trackIndex: 1 }));
    await flushMicrotasks();
    expect(selectIsEnded(usePlayer.getState())).toBe(true);
  });

  it("the end at the server's end of the last file finishes the book", async () => {
    await resume(lengths[0] + 120);
    pushSnapshot(snap('playing', 125, { trackIndex: 1 }));
    mockSaveProgress.mockClear();
    pushSnapshot(snap('ended', 136, { trackIndex: 1 }));
    await flushMicrotasks();
    expect(selectIsEnded(usePlayer.getState())).toBe(true);
    expect(savedFinished()).toBe(true);
  });

  // The native and web services keep their last state: a move on a book that ended re-reports
  // `ended` with the asked place, which is no new end.
  it('a seek or a track jump on a book that ended is no fault', async () => {
    await resume(lengths[0] + 120);
    pushSnapshot(snap('playing', 125, { trackIndex: 1 }));
    pushSnapshot(snap('ended', 138.6, { trackIndex: 1 }));
    await flushMicrotasks();
    expect(selectIsEnded(usePlayer.getState())).toBe(true);
    await usePlayer.getState().seekBook(lengths[0] + 50);
    pushSnapshot(snap('ended', 50, { trackIndex: 1 }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'ended', position: 50 });
    await usePlayer.getState().goToTrack(0);
    pushSnapshot(snap('ended', 0, { trackIndex: 0 }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'ended', trackIndex: 0 });
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  it('a report from the file the store showed, before a move back landed, is no fault', async () => {
    await resume(lengths[0] + 10);
    pushSnapshot(snap('playing', 11, { trackIndex: 1 }));
    pushSnapshot(snap('playing', 14, { trackIndex: 1 }));
    // The engine's tick from file 2 arrives while the skip back into file 1 is still out.
    (mockSvc.skipToTrack as jest.Mock).mockImplementationOnce(async () => {
      pushSnapshot(snap('playing', 14.5, { trackIndex: 1 }));
    });
    await usePlayer.getState().skipSeconds(-30);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('playing');
    // The ask still stands once the move lands: a run off the end of file 1 is caught.
    pushSnapshot(snap('playing', 123.5, { trackIndex: 0, duration: short }));
    ranOff();
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', trackIndex: 0 });
  });

  it("the lock screen's next while playing, its file change ahead of the move, is no fault", async () => {
    await resume(30);
    pushSnapshot(snap('playing', 30.2, { trackIndex: 0 }));
    pushSnapshot(snap('playing', 31, { trackIndex: 0 }));
    // Android reports the file change before `onRemoteMove`, inside PLAYED_ON of the resume.
    pushSnapshot(snap('playing', 0, { trackIndex: 1 }));
    remoteMove!(1, 0);
    pushSnapshot(snap('playing', 0.5, { trackIndex: 1 }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', trackIndex: 1 });
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  it('a seek on a faulted book puts the engine in the snapshot file by its index', async () => {
    await resume(30);
    ranOff();
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    (mockSvc.seekTo as jest.Mock).mockClear();
    await usePlayer.getState().seekInTrack(60);
    expect(mockSvc.skipToTrack).toHaveBeenLastCalledWith(0, 60);
    expect(mockSvc.seekTo).not.toHaveBeenCalled();
    // The engine may not be where the book shows (a seek it took clamped), so the book is
    // still faulted: the next move is put by index too.
    await usePlayer.getState().seekInTrack(40);
    expect(mockSvc.skipToTrack).toHaveBeenLastCalledWith(0, 40);
    expect(mockSvc.seekTo).not.toHaveBeenCalled();
  });

  it('a move the engine refuses leaves a faulted book faulted', async () => {
    await resume(30);
    ranOff();
    await flushMicrotasks();
    (mockSvc.skipToTrack as jest.Mock).mockRejectedValueOnce(new Error('refused'));
    await expect(usePlayer.getState().seekInTrack(60)).rejects.toThrow('refused');
    // The engine is still where it faulted: its play is not taken, and is stopped again, and
    // the place shown is still the one it faulted at.
    (mockSvc.pause as jest.Mock).mockClear();
    pushSnapshot(snap('playing', 1.4, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 30,
    });
    expect(mockSvc.pause).toHaveBeenCalled();
    // And the next move still puts the engine in the snapshot's file by its index.
    await usePlayer.getState().seekInTrack(60);
    expect(mockSvc.skipToTrack).toHaveBeenLastCalledWith(0, 60);
  });

  it('two moves the engine refuses, the second made before the first settled, leave the fault', async () => {
    await resume(30);
    ranOff();
    await flushMicrotasks();
    let refuseFirst: (e: Error) => void = () => undefined;
    (mockSvc.skipToTrack as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((_, reject) => (refuseFirst = reject)),
    );
    const first = usePlayer.getState().seekInTrack(60);
    await flushMicrotasks();
    (mockSvc.skipToTrack as jest.Mock).mockRejectedValueOnce(new Error('refused'));
    await expect(usePlayer.getState().seekInTrack(40)).rejects.toThrow('refused');
    refuseFirst(new Error('refused'));
    await expect(first).rejects.toThrow('refused');
    (mockSvc.pause as jest.Mock).mockClear();
    pushSnapshot(snap('playing', 1.4, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', trackIndex: 0 });
    expect(mockSvc.pause).toHaveBeenCalled();
  });

  describe('on iOS, a remote move into a later file at a place in it', () => {
    /** Resumed at 30 s, still buffering there; the lock screen's next chapter, 45 s into
     * file 2: iOS tells the file at 0, then the place, and `onRemoteMove` only once the
     * deferred seek lands. */
    const moveIntoFile2 = async () => {
      await resume(30);
      pushSnapshot(snap('loading', 30, { trackIndex: 0 }));
      pushSnapshot(snap('loading', 0, { trackIndex: 1 }));
      pushSnapshot(snap('loading', 45, { trackIndex: 1 }));
    };

    it('waits for its deferred seek past the fault hold', async () => {
      await moveIntoFile2();
      jest.advanceTimersByTime(FAULT_HOLD_MS * 3); // a slow stream
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot.state).not.toBe('error');
      remoteMove!(1, 45);
      pushSnapshot(snap('playing', 45.5, { trackIndex: 1 }));
      jest.advanceTimersByTime(ASK_SETTLE_MAX_MS);
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot).toMatchObject({
        state: 'playing',
        trackIndex: 1,
        position: 45.5,
      });
      expect(mockSvc.pause).not.toHaveBeenCalled();
    });

    it('is a fault once no move came within the settle bound', async () => {
      // Started playing at the asked place (no stall), not yet played on from it.
      await resume(30);
      pushSnapshot(snap('playing', 30.2, { trackIndex: 0 }));
      pushSnapshot(snap('loading', 0, { trackIndex: 1 }));
      pushSnapshot(snap('loading', 45, { trackIndex: 1 }));
      jest.advanceTimersByTime(ASK_SETTLE_MAX_MS - 1);
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot.state).not.toBe('error');
      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot).toMatchObject({
        state: 'error',
        trackIndex: 0,
        position: 30,
      });
    });

    it('a run off the asked file still stops after the fault hold', async () => {
      await resume(30);
      pushSnapshot(snap('playing', 0, { trackIndex: 1, duration: short }));
      jest.advanceTimersByTime(300);
      pushSnapshot(snap('playing', 0.3, { trackIndex: 1, duration: short }));
      jest.advanceTimersByTime(FAULT_HOLD_MS - 300);
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', trackIndex: 0 });
    });

    it('a run off whose ticks reach JS in a burst still stops after the fault hold', async () => {
      // JS was busy: ten seconds of the run's ticks, a second of the media apart, come at once.
      await resume(30);
      pushSnapshot(snap('playing', 0, { trackIndex: 1, duration: short }));
      for (let p = 1; p <= 10; p++) {
        pushSnapshot(snap('playing', p, { trackIndex: 1, duration: short }));
      }
      jest.advanceTimersByTime(FAULT_HOLD_MS);
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot).toMatchObject({
        state: 'error',
        trackIndex: 0,
        position: 30,
      });
    });
  });

  it('a seek back the engine never took stands no longer once it plays on where it was', async () => {
    // Three files: the engine stays in the second, and goes on into the third by itself.
    const paths = [...files, 'A/Vbr/03.mp3'];
    const secs = [...lengths, 120];
    const three: ChaptersResponse = {
      ...chapters,
      duration: 398.11,
      files: paths.map((rel_path, seq) => ({
        rel_path,
        seq,
        duration: secs[seq],
        format: 'mp3',
        size: 1,
      })),
      chapters: paths.map((file_path, index) => ({
        index,
        title: `Part ${index + 1}`,
        file_index: index,
        file_path,
        start: 0,
        end: secs[index],
        book_offset: secs.slice(0, index).reduce((a, b) => a + b, 0),
      })),
    };
    await usePlayer.getState().playBook('c1', 2, book, three, lengths[0] + 10);
    pushSnapshot(snap('playing', 11, { trackIndex: 1 }));
    pushSnapshot(snap('playing', 14, { trackIndex: 1 }));
    (mockSvc.skipToTrack as jest.Mock).mockRejectedValueOnce(new Error('refused'));
    await expect(usePlayer.getState().seekBook(100)).rejects.toThrow('refused');
    for (let at = 15; at < 138; at++) pushSnapshot(snap('playing', at, { trackIndex: 1 }));
    pushSnapshot(snap('playing', 0.3, { trackIndex: 2 }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', trackIndex: 2 });
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  it('a late report of a jump on, sent before a seek back replaced it, is no fault', async () => {
    await resume(30);
    pushSnapshot(snap('playing', 31, { trackIndex: 0 }));
    pushSnapshot(snap('playing', 34, { trackIndex: 0 }));
    await usePlayer.getState().goToTrack(1);
    await usePlayer.getState().seekBook(100);
    pushSnapshot(snap('playing', 0.2, { trackIndex: 1 })); // the jump's, only now
    pushSnapshot(snap('playing', 100.1, { trackIndex: 0 }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'playing',
      trackIndex: 0,
      position: 100.1,
    });
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  /** The book's download lands: the hot-swap moves the engine onto its files. */
  const downloadLands = () => {
    const manifest: DownloadManifest = {
      book,
      chapters,
      files: files.map((relPath, i) => ({ relPath, localUri: `file:///dl/${i}.mp3` })),
      coverUri: null,
      savedAt: '2026-01-01T00:00:00Z',
    };
    useDownloads.setState({
      entries: {
        'c1:2:A/Vbr': {
          connectionId: 'c1',
          libraryId: 2,
          path: 'A/Vbr',
          title: book.title,
          status: 'downloaded',
          progress: 1,
          bytes: 0,
          totalBytes: 0,
          manifest,
        },
      },
    });
  };

  it("a faulted book is still faulted on its download's files: a press reloads it", async () => {
    await resume(30);
    ranOff();
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    downloadLands();
    await flushMicrotasks();
    const urls = () =>
      ((mockSvc.load as jest.Mock).mock.lastCall?.[0] as { url: string }[]).map((t) => t.url);
    expect(urls()).toEqual(['file:///dl/0.mp3', 'file:///dl/1.mp3']);
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', trackIndex: 0 });
    // The engine reports from the download's files: still not heard.
    pushSnapshot(snap('playing', 0.4, { trackIndex: 1, duration: short }));
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', trackIndex: 0 });
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().toggle();
    expect(lastLoad()).toEqual([0, 30]);
  });

  it("the download swap's load is an ask too: a run off the local file stops at the place", async () => {
    await resume(30);
    pushSnapshot(snap('playing', 30.2, { trackIndex: 0 }));
    pushSnapshot(snap('playing', 50, { trackIndex: 0 })); // played on: no ask stands
    downloadLands();
    await flushMicrotasks();
    expect(lastLoad()).toEqual([0, 50]);
    expect(usePlayer.getState().nowPlaying?.queue.tracks[0].url).toBe('file:///dl/0.mp3');
    // The engine measured the download's file 1 at 29.9 s as well: on into file 2.
    ranOff();
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 50,
    });
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().toggle();
    expect(lastLoad()).toEqual([0, 50]);
  });

  it("a file played on from the download swap's place goes on into the next one", async () => {
    await resume(30);
    pushSnapshot(snap('playing', 50, { trackIndex: 0 }));
    downloadLands();
    await flushMicrotasks();
    pushSnapshot(snap('playing', 50.6, { trackIndex: 0 }));
    pushSnapshot(snap('playing', 139, { trackIndex: 0 }));
    pushSnapshot(snap('playing', 0.4, { trackIndex: 1 }));
    jest.advanceTimersByTime(FAULT_HOLD_MS);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', trackIndex: 1 });
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  it("an ask still standing stands on the download's queue once a gapless swap commits", async () => {
    const web = mockSvc as unknown as { swapTo?: jest.Mock };
    web.swapTo = jest.fn(async () => 'swapped');
    try {
      await resume(30);
      pushSnapshot(snap('playing', 30.2, { trackIndex: 0 }));
      downloadLands();
      await flushMicrotasks();
      expect(web.swapTo).toHaveBeenCalledTimes(1);
      expect(usePlayer.getState().nowPlaying?.queue.tracks[0].url).toBe('file:///dl/0.mp3');
      // The resume's ask was never played on from: a run off file 1 is still the engine's.
      ranOff();
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot).toMatchObject({
        state: 'error',
        trackIndex: 0,
        position: 30,
      });
    } finally {
      delete web.swapTo;
    }
  });

  it('a run held for a move is still decided once a gapless swap commits inside the wait', async () => {
    const web = mockSvc as unknown as { swapTo?: jest.Mock };
    web.swapTo = jest.fn(async () => 'swapped');
    try {
      await resume(30);
      pushSnapshot(snap('playing', 0.4, { trackIndex: 1, duration: short })); // held
      downloadLands();
      await flushMicrotasks();
      expect(usePlayer.getState().nowPlaying?.queue.tracks[0].url).toBe('file:///dl/0.mp3');
      jest.advanceTimersByTime(FAULT_HOLD_MS);
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot).toMatchObject({
        state: 'error',
        trackIndex: 0,
        position: 30,
      });
      expect(mockSvc.pause).toHaveBeenCalled();
    } finally {
      delete web.swapTo;
    }
  });

  it("a report still told as playing once the fault's pause call resolved is not the listener's play", async () => {
    await resume(30);
    ranOff(); // the pause call resolves at once, as a native one does, before the engine paused
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    // The web's pause tells the place once more first; a native tick carries the last state.
    pushSnapshot(snap('playing', 1.1, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', trackIndex: 0 });
    // Paused now: the next play is the listener's.
    pushSnapshot(snap('paused', 1.1, { trackIndex: 1, duration: short }));
    pushSnapshot(snap('playing', 1.1, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(lastLoad()).toEqual([0, 30]);
  });

  it('a book the route switch loaded back on the phone is asked for: a run off it stops there', async () => {
    await resume(30);
    pushSnapshot(snap('playing', 50, { trackIndex: 0 })); // played on: no ask stands
    // A Cast session ends at 80 s: the place comes back paused, then the phone loads it.
    pushSnapshot(snap('paused', 80, { trackIndex: 0 }));
    ownLoad!(0, 80, Promise.resolve());
    await flushMicrotasks();
    await usePlayer.getState().toggle();
    ranOff();
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 80,
    });
  });

  it("the route switch's own load that fails leaves no ask, and a faulted book its fault", async () => {
    await resume(30);
    pushSnapshot(snap('playing', 50, { trackIndex: 0 }));
    pushSnapshot(snap('paused', 80, { trackIndex: 0 }));
    ownLoad!(0, 80, Promise.reject(new Error('no engine')));
    await flushMicrotasks();
    await usePlayer.getState().toggle();
    pushSnapshot(snap('playing', 0.4, { trackIndex: 1 }));
    jest.advanceTimersByTime(FAULT_HOLD_MS);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', trackIndex: 1 });
    // Faulted: the own load is no ask (it would end the fault), and a press still reloads.
    await resume(30);
    ranOff();
    await flushMicrotasks();
    ownLoad!(1, 0.4, Promise.resolve());
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().toggle();
    expect(lastLoad()).toEqual([0, 30]);
  });

  it('the web waits for no move: a run off the asked file stops at once', async () => {
    const os = Platform.OS;
    Platform.OS = 'web';
    try {
      await resume(30);
      // Nothing but the store's own asks changes the file there: no `onRemoteMove` can follow.
      pushSnapshot(snap('playing', 0.4, { trackIndex: 1, duration: short }));
      expect(usePlayer.getState().snapshot).toMatchObject({
        state: 'error',
        trackIndex: 0,
        position: 30,
      });
      expect(mockSvc.pause).toHaveBeenCalled();
    } finally {
      Platform.OS = os;
    }
  });

  it("a headset's next before the engine played on is no fault, its move told after the file", async () => {
    await resume(30);
    pushSnapshot(snap('loading', 30, { trackIndex: 0 })); // still buffering at the resumed place
    // Android's module tells the move up to 300 ms after the file change.
    pushSnapshot(snap('loading', 0, { trackIndex: 1 }));
    jest.advanceTimersByTime(300);
    remoteMove!(1, 0);
    pushSnapshot(snap('playing', 0.5, { trackIndex: 1 }));
    jest.advanceTimersByTime(FAULT_HOLD_MS);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', trackIndex: 1 });
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  it('a run into a later file is taken back by a report from the asked file within the wait', async () => {
    await resume(30);
    pushSnapshot(snap('playing', 0.2, { trackIndex: 1 })); // a late report, from before
    pushSnapshot(snap('playing', 30.3, { trackIndex: 0 }));
    jest.advanceTimersByTime(FAULT_HOLD_MS);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', trackIndex: 0 });
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  it('a move back that runs off a short measure into the file the store showed is a fault', async () => {
    await resume(lengths[0] + 10);
    pushSnapshot(snap('playing', 11, { trackIndex: 1 }));
    pushSnapshot(snap('playing', 14, { trackIndex: 1 }));
    await usePlayer.getState().skipSeconds(-30); // back into file 1, at 123.42 s
    // File 1 measured at 29.9 s: the engine runs on into file 2, the file the store shows.
    pushSnapshot(snap('playing', 0.3, { trackIndex: 1, duration: short }));
    jest.advanceTimersByTime(FAULT_HOLD_MS);
    await flushMicrotasks();
    const { snapshot } = usePlayer.getState();
    expect(snapshot).toMatchObject({ state: 'error', trackIndex: 0 });
    expect(snapshot.position).toBeCloseTo(lengths[0] - 16, 6);
  });

  it('a tick sent before a seek back took never reads as having played on from it', async () => {
    await resume(lengths[0] + 60);
    pushSnapshot(snap('playing', 61, { trackIndex: 1 }));
    pushSnapshot(snap('playing', 64, { trackIndex: 1 }));
    // Back to 20 s in the last file, which the engine measured at 15 s. Its tick from 64.5 s
    // comes in while the seek is out.
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(async () => {
      pushSnapshot(snap('playing', 64.5, { trackIndex: 1 }));
    });
    await usePlayer.getState().seekInTrack(20);
    mockSaveProgress.mockClear();
    pushSnapshot(snap('ended', 15, { trackIndex: 1, duration: 15 }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 1,
      position: 20,
    });
    expect(selectIsEnded(usePlayer.getState())).toBe(false);
    expect(savedFinished()).toBe(false);
  });

  it('an end at once as a start loads is an error at once, not a spinner until the watchdog', async () => {
    await resume(lengths[0] + 89.898);
    pushSnapshot(snap('ended', short, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 1,
      position: 89.898,
    });
    expect(savedFinished()).toBe(false);
  });

  it("an end as a start loads at a file's start is still the start's", async () => {
    await resume(lengths[0]);
    pushSnapshot(snap('ended', 0, { trackIndex: 1 }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('loading');
    expect(mockSvc.pause).not.toHaveBeenCalled();
  });

  it('a play from the lock screen once the faulted engine stopped reloads the book', async () => {
    await resume(30);
    let landPause!: () => void;
    (mockSvc.pause as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (landPause = resolve)),
    );
    ranOff();
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    // On until the fault's pause lands: paused again, nothing more.
    pushSnapshot(snap('playing', 1.2, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(mockSvc.load).not.toHaveBeenCalled();
    landPause();
    await flushMicrotasks();
    pushSnapshot(snap('paused', 1.3, { trackIndex: 1, duration: short }));
    // The lock screen's play: a press, which reloads the book at its place.
    pushSnapshot(snap('playing', 1.3, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    expect(lastLoad()).toEqual([0, 30]);
  });

  it("a faulted engine done buffering before the fault's pause lands is no play of the listener's", async () => {
    await resume(30);
    let landPause!: () => void;
    (mockSvc.pause as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (landPause = resolve)),
    );
    // Still buffering the next file when the wait is over: the fault is a `loading` one.
    pushSnapshot(snap('loading', 0, { trackIndex: 1, duration: short }));
    jest.advanceTimersByTime(FAULT_HOLD_MS);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot.state).toBe('error');
    (mockSvc.load as jest.Mock).mockClear();
    pushSnapshot(snap('playing', 0.1, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(mockSvc.load).not.toHaveBeenCalled();
    landPause();
    await flushMicrotasks();
    expect(mockSvc.load).not.toHaveBeenCalled();
  });

  it('a pause during the wait never makes the later file the place', async () => {
    await resume(30);
    pushSnapshot(snap('playing', 0.4, { trackIndex: 1, duration: short }));
    mockSaveProgress.mockClear();
    await usePlayer.getState().pause();
    pushSnapshot(snap('paused', 0.5, { trackIndex: 1, duration: short }));
    jest.advanceTimersByTime(FAULT_HOLD_MS);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 30,
    });
    expect(
      mockSaveProgress.mock.calls.some((c) => (c[1] as { file?: string }).file === files[1]),
    ).toBe(false);
  });

  it('the next report decides a run held while the timers are paused (Android background)', async () => {
    await resume(30);
    pushSnapshot(snap('loading', 0, { trackIndex: 1, duration: short }));
    expect(usePlayer.getState().snapshot.state).not.toBe('error');
    // The hold's timer never fires; the clock goes on.
    jest.setSystemTime(Date.now() + FAULT_HOLD_MS);
    pushSnapshot(snap('playing', 0.2, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 30,
    });
    expect(mockSvc.pause).toHaveBeenCalled();
  });

  it('a seek whose call never settles is no fault once the engine has played on from it', async () => {
    await resume(30);
    pushSnapshot(snap('playing', 31, { trackIndex: 0 }));
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(() => new Promise<void>(() => {}));
    void usePlayer.getState().seekInTrack(50);
    await flushMicrotasks();
    jest.setSystemTime(Date.now() + ASK_SETTLE_MAX_MS);
    pushSnapshot(snap('playing', 60, { trackIndex: 0 }));
    pushSnapshot(snap('playing', 139, { trackIndex: 0 }));
    pushSnapshot(snap('playing', 0.4, { trackIndex: 1 }));
    jest.advanceTimersByTime(FAULT_HOLD_MS);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', trackIndex: 1 });
  });

  it('a lock-screen move on a faulted book is where a Retry reloads it', async () => {
    await resume(30);
    ranOff();
    await flushMicrotasks();
    remoteMove!(0, 80);
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 80,
      duration: 139.42,
    });
    await usePlayer.getState().retry();
    expect(lastLoad()).toEqual([0, 80]);
  });

  it('a skip on a faulted book, then a lock-screen move, are where a Retry reloads it', async () => {
    await resume(30);
    ranOff();
    await flushMicrotasks();
    mockSaveProgress.mockClear();
    // +30 past the engine's measure: it clamps the seek to its end and takes it, so the book
    // is no longer faulted, only in error, and the engine's reports are held off.
    await usePlayer.getState().skipSeconds(30);
    pushSnapshot(snap('paused', short, { trackIndex: 0, duration: short }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 60,
      duration: 139.42,
    });
    expect(savedPositions().at(-1)).toBe(60);
    // The lock screen's previous then moves the engine to the file's start.
    remoteMove!(0, 0);
    pushSnapshot(snap('paused', 0, { trackIndex: 0, duration: short }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 0,
    });
    await usePlayer.getState().retry();
    expect(lastLoad()).toEqual([0, 0]);
  });

  it('a next on a faulted book shows, saves and reloads at the next file', async () => {
    await resume(30);
    ranOff();
    await flushMicrotasks();
    mockSaveProgress.mockClear();
    await usePlayer.getState().goToTrack(1);
    expect(mockSvc.skipToTrack).toHaveBeenLastCalledWith(1, 0);
    pushSnapshot(snap('paused', 0, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 1,
      position: 0,
      duration: 138.69,
    });
    // The place saved is the one shown.
    expect(savedPositions().at(-1)).toBe(lengths[0]);
    // A scrub there moves within the next file, put there by index (the book is in error).
    await usePlayer.getState().seekInTrack(20);
    expect(mockSvc.skipToTrack).toHaveBeenLastCalledWith(1, 20);
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 20 });
    await usePlayer.getState().retry();
    expect(lastLoad()).toEqual([1, 20]);
  });

  it('a move on a faulted book the listener moved on from before it landed shows nothing', async () => {
    await resume(30);
    ranOff();
    await flushMicrotasks();
    let take: () => void = () => undefined;
    (mockSvc.skipToTrack as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (take = resolve)),
    );
    const next = usePlayer.getState().goToTrack(1);
    await flushMicrotasks();
    // The lock screen moves on meanwhile: its place stands once the next lands.
    remoteMove!(0, 80);
    take();
    await next;
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 0, position: 80 });
  });

  it('a move on a book that is not in error leaves its place to the engine', async () => {
    await resume(30);
    pushSnapshot(snap('paused', 30, { trackIndex: 0 }));
    await usePlayer.getState().goToTrack(1);
    // Nothing reported yet: the snapshot is still the engine's last place.
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 0, position: 30 });
    pushSnapshot(snap('paused', 0, { trackIndex: 1 }));
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 1, position: 0 });
  });

  it('a play press on a book in error after a clamped skip reloads at the place shown', async () => {
    await resume(30);
    ranOff();
    await flushMicrotasks();
    // The engine takes the skip clamped at its short measure; the book shows 60.
    await usePlayer.getState().skipSeconds(30);
    pushSnapshot(snap('paused', short, { trackIndex: 0, duration: short }));
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    // Play (the Up next card, the command palette), not Retry: never the engine from its end.
    await usePlayer.getState().toggle();
    expect(lastLoad()).toEqual([0, 60]);
  });

  it('a lock-screen play on a book in error after a clamped skip reloads at the place shown', async () => {
    await resume(30);
    ranOff();
    await flushMicrotasks();
    await usePlayer.getState().skipSeconds(30);
    pushSnapshot(snap('paused', short, { trackIndex: 0, duration: short }));
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    (mockSvc.pause as jest.Mock).mockClear();
    // The engine plays from its clamped end by itself: paused, and reloaded where the book
    // shows, never a run on into the next file.
    pushSnapshot(snap('playing', short, { trackIndex: 0, duration: short }));
    await flushMicrotasks();
    expect(mockSvc.pause).toHaveBeenCalled();
    expect(lastLoad()).toEqual([0, 60]);
  });

  it("a late play report from before the fault's pause landed is not the place after a move", async () => {
    await resume(30);
    ranOff(); // the pause call resolves at once, before the engine paused
    await flushMicrotasks();
    await usePlayer.getState().skipSeconds(30);
    expect(usePlayer.getState().snapshot).toMatchObject({ trackIndex: 0, position: 60 });
    (mockSvc.load as jest.Mock).mockClear();
    (mockSvc.pause as jest.Mock).mockClear();
    // A tick of the engine still playing on where it faulted: paused again, the place kept.
    pushSnapshot(snap('playing', 1.0, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 60,
    });
    expect(mockSvc.pause).toHaveBeenCalled();
    expect(mockSvc.load).not.toHaveBeenCalled();
  });

  it("a Cast checkpoint of a book in error is not the book's place", async () => {
    await resume(30);
    pushSnapshot(snap('playing', 34, { trackIndex: 0 }));
    pushSnapshot(snap('error', 34, { trackIndex: 0 }));
    await flushMicrotasks();
    remoteMove!(0, 80, true);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 34 });
  });

  it("a Cast checkpoint of a faulted book's place is not the book's place", async () => {
    await resume(30);
    ranOff();
    await flushMicrotasks();
    mockSaveProgress.mockClear();
    remoteMove!(1, 0.4, true);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 30,
    });
    expect(mockSaveProgress).not.toHaveBeenCalled();
    await usePlayer.getState().retry();
    expect(lastLoad()).toEqual([0, 30]);
  });

  it('a Cast checkpoint during the wait for a move does not call the fault off', async () => {
    await resume(30);
    pushSnapshot(snap('playing', 0.4, { trackIndex: 1, duration: short }));
    remoteMove!(1, 0.4, true);
    jest.advanceTimersByTime(FAULT_HOLD_MS);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 30,
    });
  });

  it('a start whose load fails leaves a later start of the same book its place and its play', async () => {
    let failFirst!: (e: Error) => void;
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((_, reject) => (failFirst = reject)),
    );
    const first = resume(30).catch(() => undefined);
    await flushMicrotasks(30);
    await resume(100); // a chapter tap while the first load is out
    failFirst(new Error('superseded'));
    await first;
    expect(usePlayer.getState().snapshot.state).not.toBe('error');
    pushSnapshot(snap('playing', 100.4, { trackIndex: 0 }));
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', position: 100.4 });
  });

  it('a start whose load fails shows the place it asked for, in its error state', async () => {
    (mockSvc.load as jest.Mock).mockRejectedValueOnce(new Error('no engine'));
    await expect(resume(lengths[0] + 40)).rejects.toThrow('no engine');
    const { snapshot } = usePlayer.getState();
    expect(snapshot).toMatchObject({ state: 'error', trackIndex: 1, duration: 138.69 });
    expect(snapshot.position).toBeCloseTo(40, 6);
    await usePlayer.getState().retry();
    const [index, position] = lastLoad() as number[];
    expect(index).toBe(1);
    expect(position).toBeCloseTo(40, 6);
  });

  describe("a place past the engine's own measure of its file (a VBR MP3's seek header)", () => {
    /** Playing 10.5 s into file 1, which the engine measures at 29.9 s. */
    const playingInFile1 = async () => {
      await resume(10);
      pushSnapshot(snap('playing', 10.5, { trackIndex: 0, duration: short }));
    };
    /** The engine takes the next seek clamped at its measure, and tells that place inside the
     * call (Media3's masked seek), `state` as it is. */
    const clampsNextSeek = (state: PlaybackState) =>
      (mockSvc.seekTo as jest.Mock).mockImplementationOnce(async () => {
        pushSnapshot(snap(state, short + 0.03, { trackIndex: 0, duration: short }));
      });

    it('a paused scrub there is an error at once, at the place asked for', async () => {
      await playingInFile1();
      await usePlayer.getState().pause();
      pushSnapshot(snap('paused', 11, { trackIndex: 0, duration: short }));
      clampsNextSeek('paused');
      await usePlayer.getState().seekInTrack(60);
      await flushMicrotasks();
      // Never the engine's clamped 29.9 s with no error.
      expect(usePlayer.getState().snapshot).toMatchObject({
        state: 'error',
        trackIndex: 0,
        position: 60,
        duration: 139.42,
      });
      // A press plays nothing from there: no reload, no play.
      (mockSvc.load as jest.Mock).mockClear();
      (mockSvc.play as jest.Mock).mockClear();
      await usePlayer.getState().toggle();
      expect(mockSvc.load).not.toHaveBeenCalled();
      expect(mockSvc.play).not.toHaveBeenCalled();
      expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 60 });
    });

    it('a playing scrub there stops at its clamped report, before a run into the next file', async () => {
      await playingInFile1();
      clampsNextSeek('playing');
      (mockSvc.pause as jest.Mock).mockClear();
      await usePlayer.getState().seekInTrack(60);
      // At once: the clamped place never shows, and no wait for a run into file 2.
      expect(usePlayer.getState().snapshot).toMatchObject({
        state: 'error',
        trackIndex: 0,
        position: 60,
      });
      expect(mockSvc.pause).toHaveBeenCalled();
      // The engine's run on before its pause lands is not taken.
      pushSnapshot(snap('playing', 0.3, { trackIndex: 1, duration: short }));
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 60 });
      expect(savedPositions().every((p) => p <= 60)).toBe(true);
    });

    it('a landing at the asked place inside the measure is no fault', async () => {
      await playingInFile1();
      (mockSvc.seekTo as jest.Mock).mockImplementationOnce(async () => {
        pushSnapshot(snap('playing', 29.5, { trackIndex: 0, duration: short }));
      });
      await usePlayer.getState().seekInTrack(29.5);
      expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', position: 29.5 });
    });

    it('a reload of a book faulted there plays nothing, a play from the lock screen neither', async () => {
      await playingInFile1();
      // Not known before: the engine takes the seek and runs off its measure into file 2.
      await usePlayer.getState().seekInTrack(60);
      ranOff();
      await flushMicrotasks();
      expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 60 });
      (mockSvc.load as jest.Mock).mockClear();
      (mockSvc.play as jest.Mock).mockClear();
      // Play and Retry: the engine would clamp at its measure and play into file 2 again.
      await usePlayer.getState().toggle();
      await usePlayer.getState().retry();
      expect(mockSvc.load).not.toHaveBeenCalled();
      expect(mockSvc.play).not.toHaveBeenCalled();
      // The lock screen's play starts the engine by itself: paused again, not reloaded.
      (mockSvc.pause as jest.Mock).mockClear();
      pushSnapshot(snap('playing', short, { trackIndex: 0, duration: short }));
      await flushMicrotasks();
      expect(mockSvc.pause).toHaveBeenCalled();
      expect(mockSvc.load).not.toHaveBeenCalled();
      expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 60 });
      // Moved back inside the measure, a press reloads there and plays.
      await usePlayer.getState().seekInTrack(20);
      await usePlayer.getState().toggle();
      expect(lastLoad()).toEqual([0, 20]);
      expect(mockSvc.play).toHaveBeenCalled();
    });

    it("a jump from a fault's place is undone back to it, never to the clamped place", async () => {
      const stop = startJumpUndo();
      try {
        await playingInFile1();
        jest.advanceTimersByTime(4_000); // past the jump undo's settle window
        pushSnapshot(snap('playing', 14.5, { trackIndex: 0, duration: short }));
        clampsNextSeek('playing');
        await usePlayer.getState().seekInTrack(100);
        await flushMicrotasks();
        // Then, a moment later, the listener goes back to the start of the book.
        jest.advanceTimersByTime(2_000);
        await usePlayer.getState().seekBook(0);
        await flushMicrotasks();
        expect(useJumpUndo.getState().jump?.from).toBe(100);
      } finally {
        stop();
        clearJumpUndo();
      }
    });
  });

  it('a Retry while a move on a book in error is still out reloads at that move', async () => {
    await resume(30);
    ranOff();
    await flushMicrotasks();
    // Android rebuilds the engine for a move on a book in error, up to a second.
    let land!: () => void;
    (mockSvc.skipToTrack as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (land = resolve)),
    );
    const moving = usePlayer.getState().seekBook(lengths[0] + 10);
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().retry();
    expect(lastLoad()).toEqual([1, 10]);
    land();
    await moving;
  });

  it('a move made before a fault, taken late, leaves a later move that calls the fault off', async () => {
    await resume(30);
    pushSnapshot(snap('playing', 30.4, { trackIndex: 0, duration: short }));
    // A seek whose call settles late: the engine runs off its measure meanwhile.
    let takeFirst!: () => void;
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (takeFirst = resolve)),
    );
    const first = usePlayer.getState().seekInTrack(40);
    await flushMicrotasks();
    ranOff();
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 40 });
    // A move on the faulted book, then the first seek's call settles, then the move is
    // refused: the first seek was taken before the fault, so the engine is still where it
    // faulted, and the fault stands again.
    let refuse!: (e: Error) => void;
    (mockSvc.skipToTrack as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((_, reject) => (refuse = reject)),
    );
    const second = usePlayer.getState().seekInTrack(20);
    await flushMicrotasks();
    takeFirst();
    await first;
    refuse(new Error('refused'));
    await expect(second).rejects.toThrow('refused');
    (mockSvc.pause as jest.Mock).mockClear();
    pushSnapshot(snap('playing', 1.4, { trackIndex: 1, duration: short }));
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', trackIndex: 0 });
    expect(mockSvc.pause).toHaveBeenCalled();
  });

  it('on iOS, a run off at 2x whose tick came late still stops after the fault hold', async () => {
    await resume(30);
    await usePlayer.getState().setRate(2);
    // A second of the media apart, the last delivered 0.75 s late: 2.5 s of media at 2x.
    for (const p of [0, 1, 2, 4.5]) {
      pushSnapshot(snap('playing', p, { trackIndex: 1, duration: short, rate: 2 }));
    }
    jest.advanceTimersByTime(FAULT_HOLD_MS);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 0,
      position: 30,
    });
  });

  it("a paused move into another file never takes that file's length for the one it left (Android)", async () => {
    await resume(10);
    // File 1 measured in full (139.42 s), file 2 short (29.9 s).
    pushSnapshot(snap('playing', 10.5, { trackIndex: 0, duration: 139.42 }));
    await usePlayer.getState().pause();
    pushSnapshot(snap('paused', 11, { trackIndex: 0, duration: 139.42 }));
    // Media3 tells a paused move's place, with the new file's length, before its file change:
    // the tick names its file.
    (mockSvc.skipToTrack as jest.Mock).mockImplementationOnce(async () => {
      pushSnapshot(snap('paused', 5, { trackIndex: 1, duration: short }));
    });
    await usePlayer.getState().seekBook(lengths[0] + 5);
    pushSnapshot(snap('paused', 5, { trackIndex: 1, duration: short }));
    // A paused scrub past file 2's measure faults there.
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(async () => {
      pushSnapshot(snap('paused', short + 0.03, { trackIndex: 1, duration: short }));
    });
    await usePlayer.getState().seekInTrack(60);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 1,
      position: 60,
    });
    // Back in file 1 at 100 s, inside its own measure: a press plays there.
    await usePlayer.getState().seekBook(100);
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().toggle();
    expect(lastLoad()).toEqual([0, 100]);
  });

  // fe#351: Media3 tells a paused move into another file at its clamped place, naming that file.
  it('a paused move into another file past its measure is an error at once, and a press plays nothing', async () => {
    await resume(10);
    pushSnapshot(snap('playing', 10.5, { trackIndex: 0, duration: 139.42 }));
    await usePlayer.getState().pause();
    pushSnapshot(snap('paused', 11, { trackIndex: 0, duration: 139.42 }));
    (mockSvc.skipToTrack as jest.Mock).mockImplementationOnce(async () => {
      pushSnapshot(snap('paused', short, { trackIndex: 1, duration: short }));
    });
    await usePlayer.getState().seekBook(lengths[0] + 60);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({
      state: 'error',
      trackIndex: 1,
      position: 60,
      duration: lengths[1],
    });
    // The clamp is the engine's measure of file 2: a press reloads nothing past it.
    (mockSvc.load as jest.Mock).mockClear();
    (mockSvc.play as jest.Mock).mockClear();
    await usePlayer.getState().toggle();
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(mockSvc.play).not.toHaveBeenCalled();
  });

  it("a reload's own report of the server's length never replaces the engine's measure", async () => {
    await resume(10);
    pushSnapshot(snap('playing', 10.5, { trackIndex: 0, duration: short }));
    // The stream fails; a press reloads at 10.5, inside the measure. The native service tells
    // the load with the server's length, in the same file, before the call resolves.
    pushSnapshot(snap('error', 10.5, { trackIndex: 0, duration: 0 }));
    (mockSvc.load as jest.Mock).mockImplementationOnce(async () => {
      pushSnapshot(snap('ready', 10.5, { trackIndex: 0, duration: lengths[0] }));
    });
    await usePlayer.getState().toggle();
    expect(lastLoad()).toEqual([0, 10.5]);
    // It fails again before a tick; the listener scrubs past the engine's measure.
    pushSnapshot(snap('error', 10.5, { trackIndex: 0, duration: 0 }));
    await flushMicrotasks();
    await usePlayer.getState().seekInTrack(60);
    await flushMicrotasks();
    (mockSvc.load as jest.Mock).mockClear();
    // Still the engine's 29.9 s: nothing is reloaded there to play into file 2.
    await usePlayer.getState().toggle();
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 60 });
  });

  it("a book faulted on the phone's measure reloads on a Cast receiver, which measures its own", async () => {
    await resume(10);
    pushSnapshot(snap('playing', 10.5, { trackIndex: 0, duration: short }));
    await usePlayer.getState().pause();
    pushSnapshot(snap('paused', 11, { trackIndex: 0, duration: short }));
    (mockSvc.seekTo as jest.Mock).mockImplementationOnce(async () => {
      pushSnapshot(snap('paused', short + 0.03, { trackIndex: 0, duration: short }));
    });
    await usePlayer.getState().seekInTrack(60);
    await flushMicrotasks();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'error', position: 60 });
    const cast = mockSvc as unknown as { isCasting?: () => boolean };
    cast.isCasting = () => true;
    try {
      (mockSvc.load as jest.Mock).mockClear();
      await usePlayer.getState().toggle();
      expect(lastLoad()).toEqual([0, 60]);
    } finally {
      delete cast.isCasting;
    }
  });
});

// --- the two readings of "the user is listening" ---------------------------

describe('selectIsPlaying vs selectIsTransportLive', () => {
  it('splits on a buffering book: live transport, but not playing', () => {
    usePlayer.setState({ snapshot: { ...INITIAL, state: 'loading' } });
    // The difference is load-bearing, not cosmetic. The sleep timer freezes its countdown
    // on the LOOSE reading, so collapsing this to strict `playing` would make every
    // buffering stall freeze and thaw the timer (sliding its deadline forward each time),
    // and a timer firing during a momentary buffer would take the "it fired against a
    // book that was not playing" branch: no pause, no grace, the book plays on and the
    // timer simply vanishes.
    expect(selectIsTransportLive(usePlayer.getState())).toBe(true);
    expect(selectIsPlaying(usePlayer.getState())).toBe(false);

    // They agree everywhere else: only `loading` is read differently.
    for (const state of ['idle', 'ready', 'paused', 'ended', 'error'] as const) {
      usePlayer.setState({ snapshot: { ...INITIAL, state } });
      expect(selectIsTransportLive(usePlayer.getState())).toBe(false);
      expect(selectIsPlaying(usePlayer.getState())).toBe(false);
    }
    usePlayer.setState({ snapshot: { ...INITIAL, state: 'playing' } });
    expect(selectIsTransportLive(usePlayer.getState())).toBe(true);
    expect(selectIsPlaying(usePlayer.getState())).toBe(true);
  });
});

// --- the one definition of the playing book's identity ---------------------

describe('selectBookKey', () => {
  it('is the connection-scoped content key, and null with nothing loaded', async () => {
    expect(selectBookKey(usePlayer.getState())).toBeNull();
    await startBook(makeBook(), 0, 'c1');
    expect(selectBookKey(usePlayer.getState())).toBe('c1:2:A/Book.m4b');
  });

  it('returns the SAME string until the book changes', async () => {
    await startBook(makeBook(), 0, 'c1');
    const first = selectBookKey(usePlayer.getState());
    // Memoized on the nowPlaying object: the sleep timer asks several times a second for
    // the whole life of a timer, and compares the answer with `===`.
    pushSnapshot(snap('playing', 10));
    expect(selectBookKey(usePlayer.getState())).toBe(first);

    await startBook(makeBook({ rel_path: 'A/Other.m4b' }), 0, 'c1');
    expect(selectBookKey(usePlayer.getState())).toBe('c1:2:A/Other.m4b');
  });

  it('distinguishes the same library + path on two different servers', async () => {
    await startBook(makeBook(), 0, 'c1');
    const onC1 = selectBookKey(usePlayer.getState());
    await startBook(makeBook(), 0, 'c2');
    expect(selectBookKey(usePlayer.getState())).not.toBe(onC1);
  });
});

// --- a new book's place is unknown until its load lands --------------------

describe('loadingBook', () => {
  it("names a new book until its engine load lands, while the snapshot still holds the old book's place", async () => {
    await startBook(makeBook(), 0, 'c1');
    pushSnapshot(snap('playing', 90));
    expect(usePlayer.getState().loadingBook).toBeNull();

    // The native engine answers the new queue only once its load resolves.
    let land: () => void = () => {};
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (land = resolve)),
    );
    const started = usePlayer
      .getState()
      .playBook('c1', 2, makeBook({ rel_path: 'A/Other.m4b' }), undefined, 0);
    await flushMicrotasks(20);
    const s = usePlayer.getState();
    expect(selectBookKey(s)).toBe('c1:2:A/Other.m4b');
    expect(s.snapshot.position).toBe(90); // the OLD book's place
    expect(s.loadingBook).toBe('c1:2:A/Other.m4b');

    land();
    await started;
    expect(usePlayer.getState().loadingBook).toBeNull();
  });

  it('stays null when the same book is started again (its place is still its own)', async () => {
    await startBook(makeBook(), 0, 'c1');
    let land: () => void = () => {};
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (land = resolve)),
    );
    const started = usePlayer.getState().playBook('c1', 2, makeBook(), undefined, 40);
    await flushMicrotasks(20);
    expect(usePlayer.getState().loadingBook).toBeNull();
    land();
    await started;
  });
});

// --- The hooks `place-reconcile.ts` uses (picking up a place another device moved on) ---

describe('holdSaves', () => {
  it('saves nothing while held, then the place once on release', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 40));
    mockSaveProgress.mockClear();
    const release = holdSaves();
    pushSnapshot(snap('paused', 45));
    await usePlayer.getState().setRate(1.5);
    await flushMicrotasks();
    expect(mockSaveProgress).not.toHaveBeenCalled();
    release();
    await flushMicrotasks();
    expect(savedPositions()).toEqual([45]);
  });

  it('saves nothing on a release without a flush (the hold ended in a move)', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 40));
    pushSnapshot(snap('paused', 45));
    await flushMicrotasks();
    mockSaveProgress.mockClear();
    const release = holdSaves();
    release({ flush: false });
    await flushMicrotasks();
    expect(mockSaveProgress).not.toHaveBeenCalled();
    // Released all the same: the next save goes through.
    pushSnapshot(snap('playing', 45));
    pushSnapshot(snap('paused', 50));
    await flushMicrotasks();
    expect(savedPositions()).toEqual([50]);
  });

  it('releases itself after 5 seconds, saving what was held', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 40));
    mockSaveProgress.mockClear();
    holdSaves();
    pushSnapshot(snap('paused', 45));
    await flushMicrotasks();
    jest.advanceTimersByTime(4_999);
    await flushMicrotasks();
    expect(mockSaveProgress).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(savedPositions()).toEqual([45]);
  });

  it('never holds a finish', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 40));
    mockSaveProgress.mockClear();
    const release = holdSaves();
    usePlayer.getState().finishBook();
    await flushMicrotasks();
    expect(mockSaveProgress.mock.calls[0][1]).toMatchObject({ finished: true });
    release({ flush: false });
  });
});

describe('onPickedUpAgain', () => {
  let calls = 0;
  let stop: () => void = () => {};
  beforeEach(() => {
    calls = 0;
    stop = onPickedUpAgain(() => calls++);
  });
  afterEach(() => stop());

  it('tells on a play after a long pause, from any source, before the play saves', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 40));
    pushSnapshot(snap('paused', 45));
    jest.advanceTimersByTime(LONG_PAUSE_MS);
    // The listener holds saves; a save in the same turn would show it came too late.
    stop();
    stop = onPickedUpAgain(() => {
      calls++;
      expect(mockSaveProgress).not.toHaveBeenCalled();
    });
    await flushMicrotasks();
    mockSaveProgress.mockClear();
    pushSnapshot(snap('playing', 45)); // a lock-screen play: no store action
    expect(calls).toBe(1);
  });

  it('stays quiet after a short pause, a stall, or the first play of a book just started', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 40));
    pushSnapshot(snap('paused', 45));
    jest.advanceTimersByTime(LONG_PAUSE_MS - 1);
    pushSnapshot(snap('playing', 45));
    // A mid-play stall is not a pause.
    pushSnapshot(snap('loading', 50));
    jest.advanceTimersByTime(LONG_PAUSE_MS);
    pushSnapshot(snap('playing', 50));
    // Paused long ago, then a book started: its place was just looked up.
    pushSnapshot(snap('paused', 50));
    jest.advanceTimersByTime(LONG_PAUSE_MS * 2);
    await startBook(makeBook({ rel_path: 'B/Other.m4b' }), 0);
    pushSnapshot(snap('playing', 0));
    expect(calls).toBe(0);
  });
});

describe('localMoveCount', () => {
  it("counts the listener's seeks, track jumps and book starts, not play or pause", async () => {
    await startBook(makeBook(), 0);
    const start = localMoveCount();
    await usePlayer.getState().seekBook(20);
    await usePlayer.getState().seekInTrack(30);
    await usePlayer.getState().goToTrack(0);
    await usePlayer.getState().skipSeconds(10);
    expect(localMoveCount()).toBe(start + 4);
    await usePlayer.getState().toggle();
    await usePlayer.getState().pause();
    expect(localMoveCount()).toBe(start + 4);
    await startBook(makeBook({ rel_path: 'B/Other.m4b' }), 0);
    expect(localMoveCount()).toBe(start + 5);
  });
});

// --- Phase 6: the native engine's own moves, speed, bookmarks and effects -----------

/** Resume a 1000 s book at `at` and get it playing there. */
async function resumeAt(at: number) {
  mockLoadInitialProgress.mockResolvedValueOnce({
    kind: 'progress',
    progress: makeProgress({ position: at, duration: 1000 }),
  });
  await usePlayer.getState().playBook('c1', 2, makeBook({ duration: 1000 }), undefined);
  pushSnapshot(snap('playing', at, { duration: 1000 }));
}

describe('a move the native engine made by itself (lock screen, headset, car)', () => {
  it('saves a scrub back 5 minutes below the resume floor', async () => {
    await resumeAt(600);
    mockSaveProgress.mockClear();
    const before = localMoveCount();

    // The native bridge takes the landed place into its snapshot, then tells the store.
    pushSnapshot(snap('playing', 300, { duration: 1000 }));
    expect(remoteMove).not.toBeNull();
    remoteMove!(0, 300);
    await flushMicrotasks();
    expect(mockSaveProgress).toHaveBeenCalled();
    expect(mockSaveProgress.mock.calls.at(-1)![1]).toMatchObject({ position: 300 });
    // The listener's own move: a place reconcile in flight stands back.
    expect(localMoveCount()).toBe(before + 1);

    // And the floor stays lowered: the pause after it saves there too.
    mockSaveProgress.mockClear();
    pushSnapshot(snap('paused', 302, { duration: 1000 }));
    await flushMicrotasks();
    expect(mockSaveProgress.mock.calls.at(-1)![1]).toMatchObject({ position: 302 });
  });

  it('without the event, the same low place is still refused (a slipped restart)', async () => {
    await resumeAt(600);
    mockSaveProgress.mockClear();
    pushSnapshot(snap('playing', 300, { duration: 1000 }));
    pushSnapshot(snap('paused', 300, { duration: 1000 }));
    await flushMicrotasks();
    expect(mockSaveProgress).not.toHaveBeenCalled();
  });
});

describe('a speed the OS set (CarPlay, the lock screen, an Android controller)', () => {
  it('is kept and saved, without sending it back to the engine', async () => {
    await resumeAt(400);
    (mockSvc.setRate as jest.Mock).mockClear();
    mockSaveProgress.mockClear();
    expect(rateChange).not.toBeNull();
    rateChange!(1.5);
    await flushMicrotasks();
    expect(usePlayer.getState().rate).toBe(1.5);
    expect(mockSvc.setRate).not.toHaveBeenCalled();
    expect(mockSaveProgress.mock.calls.at(-1)![1]).toMatchObject({ playback_speed: 1.5 });
  });

  it("clamps a speed outside the app's range, and puts the engine on the clamped one", async () => {
    await resumeAt(400);
    (mockSvc.setRate as jest.Mock).mockClear();
    rateChange!(3);
    await flushMicrotasks();
    expect(usePlayer.getState().rate).toBe(2);
    expect(mockSvc.setRate).toHaveBeenCalledWith(2);
  });
});

describe("the book's identity goes to the engine with every load", () => {
  const ref = { connectionId: 'c1', libraryId: 2, path: 'A/Book.m4b' };

  it('on a start and on a retry', async () => {
    await startBook(makeBook(), 10);
    expect((mockSvc.load as jest.Mock).mock.calls.at(-1)![4]).toEqual(ref);
    pushSnapshot(snap('playing', 10));
    (mockSvc.load as jest.Mock).mockClear();
    await usePlayer.getState().retry();
    expect((mockSvc.load as jest.Mock).mock.calls.at(-1)![4]).toEqual(ref);
  });

  it('on the move onto the downloaded copy', async () => {
    await startBook(makeBook(), 10);
    pushSnapshot(snap('playing', 10));
    (mockSvc.load as jest.Mock).mockClear();
    const manifest: DownloadManifest = {
      book: makeBook(),
      chapters: null,
      files: [{ relPath: 'A/Book.m4b', localUri: 'file:///c1/0.m4b' }],
      coverUri: null,
      savedAt: '2026-01-01T00:00:00Z',
    };
    useDownloads.setState({
      entries: {
        'c1:2:A/Book.m4b': {
          connectionId: 'c1',
          libraryId: 2,
          path: 'A/Book.m4b',
          title: 'A Book',
          status: 'downloaded',
          progress: 1,
          bytes: 0,
          totalBytes: 0,
          manifest,
        },
      },
    });
    await flushMicrotasks();
    expect(mockSvc.load).toHaveBeenCalledTimes(1);
    expect((mockSvc.load as jest.Mock).mock.calls[0][0][0].url).toBe('file:///c1/0.m4b');
    expect((mockSvc.load as jest.Mock).mock.calls[0][4]).toEqual(ref);
  });
});

describe('Smart Speed and Voice Boost', () => {
  it('reach the engine with the other tunables, and again when changed', async () => {
    await startBook(makeBook(), 10);
    (mockSvc.configure as jest.Mock).mockClear();
    useSettings.getState().setSmartSpeed(true);
    useSettings.getState().setVoiceBoost(true);
    expect((mockSvc.configure as jest.Mock).mock.calls.at(-1)![0]).toMatchObject({
      smartSpeed: true,
      voiceBoost: true,
    });
    useSettings.setState({ smartSpeed: false, voiceBoost: false });
  });

  it("counts the engine's silence total on the playing book", async () => {
    await startBook(makeBook(), 10);
    expect(silenceSaved).not.toBeNull();
    silenceSaved!(12.5);
    expect(mockNoteSilenceSaved).toHaveBeenCalledWith(12.5, 'c1:2:A/Book.m4b');
  });

  // A tick of another book the engine plays (the car started it, not adopted yet) is none of
  // the playing book's time saved.
  it("counts another book's silence total on no book", async () => {
    await startBook(makeBook(), 10);
    const svc = mockSvc as PlaybackService & { reportedBook?: () => unknown };
    svc.reportedBook = () => ({ connectionId: 'c1', libraryId: 2, path: 'Another' });
    try {
      silenceSaved!(14);
      expect(mockNoteSilenceSaved).toHaveBeenLastCalledWith(14, null);
    } finally {
      delete svc.reportedBook;
    }
  });

  it('saves the counts when playback halts', async () => {
    await startBook(makeBook(), 10);
    pushSnapshot(snap('playing', 10));
    mockFlushTimeSaved.mockClear();
    pushSnapshot(snap('paused', 12));
    expect(mockFlushTimeSaved).toHaveBeenCalledTimes(1);
  });
});

// --- the listening span as the page goes (PLAYER-03) ------------------------

describe('the listening span when the page goes or hides (web)', () => {
  const addHistory = fakeClient.addHistory as jest.Mock;
  const keepalives = () =>
    addHistory.mock.calls.map((c) => (c[3] as { keepalive: boolean }).keepalive);

  async function playing() {
    await startBook();
    pushSnapshot(snap('playing', 10));
    addHistory.mockClear();
  }

  it('closing the tab while playing posts the span once, with keepalive', async () => {
    await playing();
    jest.advanceTimersByTime(45_000);
    pushSnapshot(snap('playing', 55));
    flushHistoryOnHide(true);
    expect(addHistory).toHaveBeenCalledTimes(1);
    expect(addHistory).toHaveBeenCalledWith(
      2,
      'A/Book.m4b',
      expect.objectContaining({ from_pos: 10, to_pos: 55 }),
      { keepalive: true },
    );
    // The page goes on to stop the audio: no second post of the same span.
    flushHistoryOnHide(true);
    pushSnapshot(snap('paused', 55));
    expect(addHistory).toHaveBeenCalledTimes(1);
  });

  it('a hidden tab splits a span long enough to keep, playing on into a new one', async () => {
    await playing();
    jest.advanceTimersByTime(10_000);
    flushHistoryOnHide(false);
    expect(addHistory).not.toHaveBeenCalled();
    jest.advanceTimersByTime(20_000);
    pushSnapshot(snap('playing', 40));
    flushHistoryOnHide(false);
    expect(keepalives()).toEqual([true]);
    jest.advanceTimersByTime(25_000);
    pushSnapshot(snap('playing', 65));
    pushSnapshot(snap('paused', 65));
    expect(addHistory).toHaveBeenCalledTimes(2);
    expect(addHistory.mock.calls[1][2]).toEqual(
      expect.objectContaining({ from_pos: 40, to_pos: 65 }),
    );
    expect(keepalives()).toEqual([true, false]);
  });

  // v2.5.1 PLAYER-14: a hard navigation pauses the audio before `pagehide`, and the span
  // that pause ended went as a plain request the page took down with it.
  it("posts a pause's span with keepalive on web, and still refreshes the history", async () => {
    const os = Platform.OS;
    Platform.OS = 'web';
    try {
      await playing();
      jest.advanceTimersByTime(30_000);
      (queryClient.invalidateQueries as jest.Mock).mockClear();
      pushSnapshot(snap('paused', 40));
      await flushMicrotasks();
      expect(keepalives()).toEqual([true]);
      expect(invalidatedKeys()).toContainEqual(qk.historyAll('c1'));
      // The page then goes: the span is already posted, once.
      flushHistoryOnHide(true);
      expect(addHistory).toHaveBeenCalledTimes(1);
    } finally {
      Platform.OS = os;
    }
  });

  it('posts nothing when nothing plays', async () => {
    await startBook();
    addHistory.mockClear();
    flushHistoryOnHide(true);
    flushHistoryOnHide(false);
    expect(addHistory).not.toHaveBeenCalled();
  });

  it('a span posted as the tab hides refreshes no history; one posted on a pause does', async () => {
    await playing();
    jest.advanceTimersByTime(30_000);
    (queryClient.invalidateQueries as jest.Mock).mockClear();
    flushHistoryOnHide(false);
    await flushMicrotasks();
    expect(invalidatedKeys()).not.toContainEqual(qk.historyAll('c1'));
    jest.advanceTimersByTime(30_000);
    pushSnapshot(snap('paused', 70));
    await flushMicrotasks();
    expect(invalidatedKeys()).toContainEqual(qk.historyAll('c1'));
  });

  it('listens for pagehide and a hidden document, and stops listening', async () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' }) as EventTarget & {
      visibilityState: DocumentVisibilityState;
    };
    const stop = watchPageHide(win, doc);
    await playing();
    jest.advanceTimersByTime(30_000);
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(addHistory).not.toHaveBeenCalled();
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(keepalives()).toEqual([true]);
    jest.advanceTimersByTime(30_000);
    win.dispatchEvent(new Event('pagehide'));
    expect(keepalives()).toEqual([true, true]);
    stop();
    await playing();
    jest.advanceTimersByTime(30_000);
    win.dispatchEvent(new Event('pagehide'));
    expect(addHistory).not.toHaveBeenCalled();
  });
});
