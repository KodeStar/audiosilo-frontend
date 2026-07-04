import type { Book, Progress } from '@/api/types';

import type { ResumeLookup } from './progress-sync';
import type { PlaybackService, PlaybackSnapshot, PlaybackState } from './types';

// --- Mocks -----------------------------------------------------------------
// The store talks to the playback engine only through createPlaybackService()
// (Metro resolves the native/web impl). We swap in a fake whose `subscribe`
// captures the listener so a test can push engine snapshots and drive the store's
// state-transition logic (save-loop start/stop, persist-on-stop) directly.

let pushSnapshot: (s: PlaybackSnapshot) => void = () => {};
const mockSvc = {
  setup: jest.fn(async () => {}),
  configure: jest.fn(async () => {}),
  load: jest.fn(async () => {}),
  play: jest.fn(async () => {}),
  pause: jest.fn(async () => {}),
  seekTo: jest.fn(async () => {}),
  skipToTrack: jest.fn(async () => {}),
  setRate: jest.fn(async () => {}),
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
const mockLoadInitialProgress = jest.fn(
  async (..._args: unknown[]): Promise<ResumeLookup> => ({ kind: 'empty' }),
);
jest.mock('./progress-sync', () => ({
  saveProgress: (...args: unknown[]) => mockSaveProgress(...args),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
  loadInitialProgress: (...args: unknown[]) => mockLoadInitialProgress(...args),
}));

// Keep React Query out of the unit test.
jest.mock('@/api/provider', () => ({
  queryClient: { invalidateQueries: jest.fn(), setQueryData: jest.fn() },
}));

// playBook resolves its ApiClient from the connection id via resolveClient(); return a
// fake so saves/history/cover URLs work without a real session. Exposed as a jest.fn so a
// test can force `null` (a connection whose token failed to hydrate - see the offline
// downloaded-book case). clearAllMocks() keeps this default implementation.
const fakeClient = {
  coverUrl: (lib: number, path: string) => `cover:${lib}:${path}`,
  streamUrl: (lib: number, path: string) => `stream:${lib}:${path}`,
  authHeaders: () => ({ Authorization: 'Bearer x' }),
  addHistory: jest.fn(async () => {}),
};
const mockResolveClient = jest.fn((_cid: string): typeof fakeClient | null => fakeClient);
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (cid: string) => mockResolveClient(cid),
  sessionReady: jest.fn(() => true),
}));

/* eslint-disable import/first */
import { useDownloads } from '@/downloads/store';
import type { DownloadEntry, DownloadManifest } from '@/downloads/types';

import { flushConnection } from './progress-sync';
import { stopPlaybackForConnection, teardownBeforeTokenRevoke, usePlayer } from './store';
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

/** Start a book so `nowPlaying` + the engine subscription are wired up. Loaded
 * through connection `c1` unless a test overrides it. */
async function startBook(book: Book = makeBook(), startPos = 0, cid = 'c1') {
  await usePlayer.getState().playBook(cid, 2, book, undefined, startPos);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
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

  it('still bails when the connection is gone AND the book is not downloaded (streaming needs a client)', async () => {
    mockResolveClient.mockReturnValueOnce(null);
    (mockSvc.load as jest.Mock).mockClear();

    await usePlayer.getState().playBook('gone', 2, makeBook(), undefined);

    // No local files + no client => nothing to play; the online/streaming path is unchanged.
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying).toBeNull();
  });
});
