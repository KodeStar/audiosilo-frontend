import type { AppStateStatus } from 'react-native';

import type { Book, Progress } from '@/api/types';

import type { ProgressSave, ResumeLookup } from './progress-sync';
import type { PlaybackService, PlaybackSnapshot, PlaybackState } from './types';

// The real store and the real reconcile over a fake engine, a fake server answer and this
// device's mirror: what a book loaded here does when another device (or the other
// AudioSilo app on the same phone) moved its place on.

let pushSnapshot: (s: PlaybackSnapshot) => void = () => {};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockPlayerSnapshot = (): PlaybackSnapshot => require('./store').usePlayer.getState().snapshot;
const mockSvc = {
  setup: jest.fn(async () => {}),
  configure: jest.fn(async () => {}),
  load: jest.fn(async () => {}),
  play: jest.fn(async () => {}),
  pause: jest.fn(async () => {}),
  // The engine reports a seek straight away, as it does.
  seekTo: jest.fn(async (position: number) => {
    pushSnapshot({ ...mockPlayerSnapshot(), position });
  }),
  skipToTrack: jest.fn(async () => {}),
  setRate: jest.fn(async () => {}),
  setVolume: jest.fn(async () => {}),
  reset: jest.fn(async () => {}),
  subscribe: jest.fn((listener: (s: PlaybackSnapshot) => void) => {
    pushSnapshot = listener;
    return () => {};
  }),
} as unknown as PlaybackService;
jest.mock('./service', () => ({ createPlaybackService: () => mockSvc }));

const mockSaveProgress = jest.fn(async (..._args: unknown[]) => {});
const mockLoadInitialProgress = jest.fn(async (..._a: unknown[]): Promise<ResumeLookup> => ({
  kind: 'empty',
}));
let mockMirror: ProgressSave | null = null;
jest.mock('./progress-sync', () => ({
  saveProgress: (...args: unknown[]) => mockSaveProgress(...args),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'this-device'),
  loadInitialProgress: (...a: unknown[]) => mockLoadInitialProgress(...a),
  readMirror: jest.fn(async () => mockMirror),
}));

jest.mock('@/api/provider', () => ({
  queryClient: {
    invalidateQueries: jest.fn(),
    setQueryData: jest.fn(),
    setQueryDefaults: jest.fn(),
    fetchQuery: jest.fn(async () => ({})),
    getQueryData: jest.fn(() => undefined),
    cancelQueries: jest.fn(async () => {}),
  },
}));
jest.mock('@/lib/network', () => ({ canAutoDownload: jest.fn(async () => false) }));

/** The server's answer to `getProgress`: a record, or a promise the test settles. */
let mockServer: () => Promise<Progress | null> = async () => null;
const mockClient = {
  coverUrl: () => 'cover',
  streamUrl: (lib: number, path: string) => `stream:${lib}:${path}`,
  authHeaders: () => ({}),
  addHistory: jest.fn(async () => {}),
  getProgress: jest.fn((_lib: number, _path: string, signal?: AbortSignal) =>
    signal
      ? new Promise<Progress | null>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
          mockServer().then(resolve, reject);
        })
      : mockServer(),
  ),
};
jest.mock('@/api/connection-clients', () => ({
  resolveClient: () => mockClient,
  sessionReady: () => true,
}));

let mockReachable = true;
let mockReconnect: ((cid: string) => void) | null = null;
jest.mock('@/api/reachability', () => ({
  ...jest.requireActual('@/api/reachability'),
  isReachable: () => mockReachable,
  onReconnect: (cb: (cid: string) => void) => {
    mockReconnect = cb;
    return () => {
      mockReconnect = null;
    };
  },
}));

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
jest.mock('@/lib/when-active', () => ({
  ...jest.requireActual('@/lib/when-active'),
  whenActive: (fn: () => void) => {
    fn();
    return () => {};
  },
}));

/* eslint-disable import/first */
import { AppState } from 'react-native';

import { useSettings } from '@/stores/settings';

import { placeToMoveTo, startPlaceReconcile } from './place-reconcile';
import { LONG_PAUSE_MS, usePlayer } from './store';
/* eslint-enable import/first */

const BOOK: Book = {
  id: 1,
  library_id: 2,
  rel_path: 'A/Book.m4b',
  is_folder: false,
  title: 'A Book',
  author: 'Author',
  series: '',
  series_index: 0,
  narrator: '',
  duration: 1000,
  format: 'm4b',
  size: 0,
};

const record = (p: Partial<Progress> = {}): Progress => ({
  library_id: 2,
  path: 'A/Book.m4b',
  position: 400,
  duration: 1000,
  finished: false,
  playback_speed: 1,
  version: 3,
  device_id: 'other-device',
  updated_at: '2026-10-08T10:00:00Z',
  ...p,
});

/** This device's newest knowledge of the book (its last save). */
const mirrorAt = (updated_at: string, position = 100): ProgressSave => ({
  connectionId: 'c1',
  libraryId: 2,
  path: 'A/Book.m4b',
  position,
  duration: 1000,
  finished: false,
  playback_speed: 1,
  device_id: 'this-device',
  updated_at,
});

const snap = (state: PlaybackState, position: number): PlaybackSnapshot => ({
  state,
  trackIndex: 0,
  position,
  duration: 1000,
  rate: 1,
});

async function settle(turns = 12) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

const saved = () => mockSaveProgress.mock.calls.map((c) => (c[1] as { position: number }).position);
const seeks = () => (mockSvc.seekTo as jest.Mock).mock.calls.map((c) => c[0] as number);

let foreground: ((s: AppStateStatus) => void) | null = null;
let stop: () => void = () => {};

/** Book loaded here, resumed at 100 s, played to 105 s and paused: the save of that
 * pause is this device's last (`mockMirror`). */
async function loadedAndPaused() {
  mockLoadInitialProgress.mockResolvedValueOnce({
    kind: 'progress',
    progress: record({
      position: 100,
      device_id: 'this-device',
      updated_at: '2026-10-08T09:00:00Z',
    }),
  });
  await usePlayer.getState().playBook('c1', 2, BOOK, undefined);
  pushSnapshot(snap('playing', 100));
  pushSnapshot(snap('paused', 105));
  await settle();
  mockMirror = mirrorAt('2026-10-08T09:05:00Z', 105);
  jest.clearAllMocks();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-08T12:00:00Z'));
  useSettings.setState({ autoDownloadNext: 'never' });
  usePlayer.setState({ nowPlaying: null, snapshot: snap('idle', 0), rate: 1 });
  mockMirror = null;
  mockReachable = true;
  // The other device played on to 400 s after this one paused.
  mockServer = async () => record();
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (s: AppStateStatus) => void,
  ) => {
    foreground = handler;
    return { remove: () => {} };
  }) as unknown as typeof AppState.addEventListener);
  Object.defineProperty(AppState, 'currentState', { get: () => 'active', configurable: true });
  stop = startPlaceReconcile();
});

afterEach(() => {
  stop();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** The app goes away and comes back. */
async function backInFront() {
  foreground?.('background');
  foreground?.('active');
  await settle();
}

describe('placeToMoveTo', () => {
  const base = {
    server: record(),
    deviceId: 'this-device',
    mirror: mirrorAt('2026-10-08T09:05:00Z'),
    enginePosition: 105,
  };

  it("moves to another device's newer place", () => {
    expect(placeToMoveTo(base)).toBe(400);
    expect(placeToMoveTo({ ...base, mirror: null })).toBe(400);
    // Behind is a place too: the other device went back.
    expect(placeToMoveTo({ ...base, enginePosition: 900 })).toBe(400);
  });

  it("stays for this device's own record, a newer local save, a near place or a finish", () => {
    expect(placeToMoveTo({ ...base, server: record({ device_id: 'this-device' }) })).toBeNull();
    expect(placeToMoveTo({ ...base, mirror: mirrorAt('2026-10-08T10:00:01Z') })).toBeNull();
    expect(placeToMoveTo({ ...base, mirror: mirrorAt('2026-10-08T10:00:00Z') })).toBeNull();
    expect(placeToMoveTo({ ...base, enginePosition: 371 })).toBeNull();
    expect(placeToMoveTo({ ...base, server: record({ finished: true }) })).toBeNull();
    expect(placeToMoveTo({ ...base, server: null })).toBeNull();
    expect(placeToMoveTo({ ...base, server: record({ device_id: '' }) })).toBeNull();
  });
});

describe('a loaded book another device has moved on', () => {
  // The two tests the investigation pinned as `it.failing` (they lived in store.test.ts).
  it('a Play press after a long pause moves the engine to the newer place', async () => {
    await loadedAndPaused();
    jest.advanceTimersByTime(LONG_PAUSE_MS);
    await usePlayer.getState().toggle();
    pushSnapshot(snap('playing', 105));
    await settle();
    expect(seeks()).toEqual([400]);
  });

  it("the stale engine place never overwrites the other device's save", async () => {
    await loadedAndPaused();
    jest.advanceTimersByTime(LONG_PAUSE_MS);
    await usePlayer.getState().toggle();
    pushSnapshot(snap('playing', 106)); // auto-rewind and a second at the old place
    await usePlayer.getState().setRate(1.2); // a save while the check is out
    await settle();
    pushSnapshot(snap('playing', 400)); // the engine reports the move
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(saved().length).toBeGreaterThan(0);
    expect(saved().every((p) => p >= 400)).toBe(true);
  });

  it('on the app coming back, moves a paused book there and says so with Undo', async () => {
    await loadedAndPaused();
    await backInFront();
    expect(seeks()).toEqual([400]);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Picked up your place from another device',
        description: 'At 6:40',
        action: expect.objectContaining({ label: 'Undo' }),
      }),
    );
    // The move saved nothing: the other device's place is already the server's.
    expect(saved()).toEqual([]);
    // Undo: back to this device's place, and its saves go on from there.
    (mockToast.mock.calls[0][0] as { action: { onPress: () => void } }).action.onPress();
    await settle();
    expect(seeks()).toEqual([400, 105]);
    expect(saved()).toEqual([105]);
    pushSnapshot(snap('playing', 105));
    pushSnapshot(snap('paused', 110));
    await settle();
    expect(saved()).toEqual([105, 110]);
  });

  it('names the chapter when the book has chapters', async () => {
    const chapters = [0, 300, 600].map((start, i) => ({
      index: i,
      title: `Ch ${i + 1}`,
      file_index: 0,
      file_path: 'A/Book.m4b',
      start,
      end: start + 300,
      book_offset: start,
    }));
    mockLoadInitialProgress.mockResolvedValueOnce({ kind: 'empty' });
    await usePlayer.getState().playBook('c1', 2, { ...BOOK, chapters }, undefined);
    pushSnapshot(snap('playing', 100));
    pushSnapshot(snap('paused', 105));
    await settle();
    await backInFront();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Chapter 2, 6:40' }),
    );
  });

  it("on the book's server coming back, moves a paused book there", async () => {
    await loadedAndPaused();
    mockReconnect?.('other-server');
    await settle();
    expect(seeks()).toEqual([]);
    mockReconnect?.('c1');
    await settle();
    expect(seeks()).toEqual([400]);
  });
});

describe('and when it stays where it is', () => {
  it('a newer save of this device (queued or not) wins', async () => {
    await loadedAndPaused();
    mockMirror = mirrorAt('2026-10-08T11:00:00Z', 105);
    await backInFront();
    expect(seeks()).toEqual([]);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("this device's own record is not another device's", async () => {
    await loadedAndPaused();
    mockServer = async () => record({ device_id: 'this-device' });
    await backInFront();
    expect(seeks()).toEqual([]);
  });

  it('a place within 30 seconds is not worth a move', async () => {
    await loadedAndPaused();
    mockServer = async () => record({ position: 130 });
    await backInFront();
    expect(seeks()).toEqual([]);
  });

  it('a book that has been playing on is never checked', async () => {
    await loadedAndPaused();
    pushSnapshot(snap('playing', 105));
    jest.advanceTimersByTime(5_000);
    pushSnapshot(snap('playing', 110));
    await backInFront();
    expect(mockClient.getProgress).not.toHaveBeenCalled();
  });

  it('a short pause asks nothing on play', async () => {
    await loadedAndPaused();
    jest.advanceTimersByTime(LONG_PAUSE_MS - 1_000);
    pushSnapshot(snap('playing', 105));
    await settle();
    expect(mockClient.getProgress).not.toHaveBeenCalled();
  });

  it('offline (a downloaded book, its server away), asks nothing and saves go on', async () => {
    await loadedAndPaused();
    mockReachable = false;
    jest.advanceTimersByTime(LONG_PAUSE_MS);
    pushSnapshot(snap('playing', 105));
    pushSnapshot(snap('paused', 120));
    await settle();
    expect(mockClient.getProgress).not.toHaveBeenCalled();
    expect(saved()).toEqual([120]);
  });

  it('a check that takes too long gives up and releases the held saves', async () => {
    await loadedAndPaused();
    mockServer = () => new Promise(() => {}); // never answers
    jest.advanceTimersByTime(LONG_PAUSE_MS);
    pushSnapshot(snap('playing', 105));
    pushSnapshot(snap('paused', 120)); // a save while held
    await settle();
    expect(saved()).toEqual([]);
    jest.advanceTimersByTime(5_000);
    await settle();
    expect(saved()).toEqual([120]);
    expect(seeks()).toEqual([]);
  });

  it("the listener's own seek during the check wins", async () => {
    await loadedAndPaused();
    let answer: (p: Progress) => void = () => {};
    mockServer = () => new Promise((resolve) => (answer = resolve));
    await backInFront();
    await usePlayer.getState().seekBook(700);
    answer(record());
    await settle();
    expect(seeks()).toEqual([700]);
    // The seek's own save was held; the release saves the listener's place.
    expect(saved()).toEqual([700]);
  });
});
