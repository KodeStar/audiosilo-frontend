import type { Book, ChaptersResponse, Progress } from '@/api/types';

import type { ResumeLookup } from './progress-sync';
import type { PlaybackService, PlaybackSnapshot, PlaybackState } from './types';

// --- Mocks -----------------------------------------------------------------
// The store talks to the playback engine only through createPlaybackService()
// (Metro resolves the native/web impl). We swap in a fake whose `subscribe`
// captures the listener so a test can push engine snapshots and drive the store's
// state-transition logic (save-loop start/stop, persist-on-stop) directly.

let pushSnapshot: (s: PlaybackSnapshot) => void = () => {};
/** The seek the store handed the engine for the OS media controls (`onRemoteSeek`). */
let remoteSeek: ((positionInTrack: number) => void) | null = null;
/** The native engine's Phase 6 handlers the store registered. */
type TrackPlace = (trackIndex: number, positionInTrack: number) => void;
let remoteMove: TrackPlace | null = null;
let rateChange: ((rate: number) => void) | null = null;
let silenceSaved: ((total: number) => void) | null = null;
const mockSvc = {
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
jest.mock('./progress-sync', () => ({
  saveProgress: (...args: unknown[]) => mockSaveProgress(...args),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
  loadInitialProgress: (...args: unknown[]) => mockLoadInitialProgress(...args),
  readMirror: (...args: unknown[]) => mockReadMirror(...args),
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
    getQueryData: jest.fn(() => undefined),
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

/* eslint-disable import/first */
import { Platform } from 'react-native';

import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { engine as downloadEngine } from '@/downloads/engine';
import { isDeclined, useDownloads } from '@/downloads/store';
import type { DownloadEntry, DownloadManifest } from '@/downloads/types';
import { resetProfilesForTests, switchProfile, useProfiles } from '@/stores/profiles';
import { useSettings } from '@/stores/settings';

import { bookFileSpecs } from './book-queue';
import { flushConnection } from './progress-sync';
import { useReachability } from '@/api/reachability';
import { AutoplayBlockedError, PlaybackStartError } from './types';
import {
  flushHistoryOnHide,
  holdSaves,
  LONG_PAUSE_MS,
  localMoveCount,
  onPickedUpAgain,
  selectBookKey,
  selectBookPosition,
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

  it('lets a genuine recovery (playing) clear the error', async () => {
    await startBook(makeBook(), 0);
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    pushSnapshot(snap('loading', 50));
    await Promise.resolve();
    jest.advanceTimersByTime(3_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('error');

    // The stream comes back on its own → the engine reports 'playing', which is not a
    // stall re-report, so it clears the error.
    pushSnapshot(snap('playing', 50));
    await Promise.resolve();
    expect(usePlayer.getState().snapshot.state).toBe('playing');
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

// --- per-connection scoping of saves + the download hot-swap -----------------

describe('connection scoping', () => {
  describe("finding 11: a switch to another server's book saves the previous book through its own server", () => {
    const client2 = { ...fakeClient, coverUrl: () => 'c2-cover' };
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
      JSON.stringify(k) === chaptersKey ? chaptersIn(serverOrder) : undefined,
    );
  });
  afterEach(() => (queryClient.getQueryData as jest.Mock).mockImplementation(() => undefined));

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

  it('saves a stop made while the swap loads', async () => {
    await streamIn(newOrder);
    let landed: () => void = () => {};
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => (landed = resolve)),
    );
    downloadLands(oldOrder);
    await flushMicrotasks();
    await usePlayer.getState().stop();
    // The stop saved the place: nothing held it.
    expect(savedPositions()).toEqual([20]);
    (mockSvc.play as jest.Mock).mockClear();
    landed();
    await flushMicrotasks();
    // The swap landing after the stop brings nothing back, and plays nothing.
    expect(usePlayer.getState().nowPlaying).toBeNull();
    expect(mockSvc.play).not.toHaveBeenCalled();
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
  });

  describe('on the web engine (a gapless swap)', () => {
    const web = mockSvc as unknown as { swapTo?: jest.Mock };
    afterEach(() => {
      delete web.swapTo;
    });

    it('commits the queue once the swap lands', async () => {
      web.swapTo = jest.fn(async () => true);
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

    it('keeps the stream, and holds nothing, when the swap is refused', async () => {
      web.swapTo = jest.fn(async () => false);
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
      let swapped: (ok: boolean) => void = () => {};
      web.swapTo = jest.fn(() => new Promise<boolean>((resolve) => (swapped = resolve)));
      await streamIn(newOrder);
      downloadLands(oldOrder);
      await flushMicrotasks();
      await usePlayer.getState().stop();
      expect(savedPositions()).toEqual([20]);
      swapped(false);
      await flushMicrotasks();
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

  it('saves nothing while the connection is gone, then saves once it is back', async () => {
    // A session that could not be read yet (a CarPlay launch with the phone locked) loads
    // its connections later, while the downloaded book plays on.
    seedDownloaded('gone');
    mockResolveClient.mockReturnValue(null);
    try {
      await usePlayer.getState().playBook('gone', 2, makeBook(), undefined);
      mockSaveProgress.mockClear();
      pushSnapshot(snap('playing', 40));
      pushSnapshot(snap('paused', 40));
      await flushMicrotasks();
      expect(mockSaveProgress).not.toHaveBeenCalled();
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

  it('posts nothing when nothing plays', async () => {
    await startBook();
    addHistory.mockClear();
    flushHistoryOnHide(true);
    flushHistoryOnHide(false);
    expect(addHistory).not.toHaveBeenCalled();
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
