import type { AppStateStatus } from 'react-native';

import { beginNetworkCheck, endNetworkCheck } from '@/api/address-route';
import type { Book, ListeningSyncResponse, Progress } from '@/api/types';

import type { InitialPlace, LatePlace, ProgressSave } from './progress-sync';
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
const mockLoadInitialProgress = jest.fn(async (..._a: unknown[]): Promise<InitialPlace> => ({
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
  ackVersion: (...a: unknown[]) => mockAckVersion(...a),
  answerOffer: async (
    cid: string,
    lib: number,
    path: string,
    row: { version: number },
    key: string,
  ) => {
    await mockAckVersion(cid, lib, path, row.version, row);
    await mockMarkAnswered(cid, lib, path, key, row);
  },
  ignoreOffer: (...a: unknown[]) => mockIgnoreOffer(...a),
  // A sync answer's rows go to the query cache as they are.
  bookPlace: async () => null,
  cachedDeviceId: () => 'this-device',
  writeMirror: jest.fn(async () => {}),
  guardSettled: () => false,
  guardHolds: jest.requireActual('./progress-sync').guardHolds,
  GUARD_SLACK_S: 30,
  placeKey: (p: { device_id?: string; updated_at: string }) => `${p.device_id}|${p.updated_at}`,
  onHeldSave: (cb: HeldCb) => {
    mockHeld = cb;
    return () => {
      mockHeld = null;
    };
  },
}));
/** The replay guard's listener (fe#198), as the reconcile registered it. */
type HeldCb = (save: ProgressSave, row: Progress, mirror: ProgressSave | null) => void;
let mockHeld: HeldCb | null = null;
const mockIgnoreOffer = jest.fn(async (..._a: unknown[]) => {});
const mockAckVersion = jest.fn(async (..._a: unknown[]) => {});
const mockMarkAnswered = jest.fn(async (..._a: unknown[]) => {});

jest.mock('@/api/provider', () => ({
  queryClient: {
    invalidateQueries: jest.fn(),
    setQueryData: jest.fn(),
    setQueryDefaults: jest.fn(),
    fetchQuery: jest.fn(async () => ({})),
    // A server without listening_sync (the PUT path), unless a test says otherwise.
    getQueryData: jest.fn((k: readonly unknown[]) =>
      k?.[0] === 'server' ? { capabilities: {} } : undefined,
    ),
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
  // Every event applied: an outbox that empties ends its flush (one answering none goes
  // round again and again, into the next tests).
  syncListening: jest.fn(
    async (body: { events: { id: string }[] }): Promise<ListeningSyncResponse> => ({
      server_time: '',
      results: body.events.map((e) => ({ id: e.id, status: 'applied' })),
      progress: [],
    }),
  ),
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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

import { useSettings } from '@/stores/settings';

import { queryClient } from '@/api/provider';

import { resetOutboxForTests } from './listening-outbox';
import {
  OFFER_REPEAT_MS,
  offerOf,
  placeToMoveTo,
  reconcileLoadedPlace,
  startPlaceReconcile,
} from './place-reconcile';
import {
  LONG_PAUSE_MS,
  PICK_UP_WAIT_MS,
  selectBookPosition,
  selectIsPlaying,
  selectIsTransportLive,
  usePlayer,
} from './store';
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

/** The server's flags as a listening_sync server's, with `capabilities` on top. */
const serverCaps = (capabilities: Record<string, boolean>) =>
  (queryClient.getQueryData as jest.Mock).mockImplementation((key: readonly unknown[]) =>
    key[0] === 'server' ? { capabilities: { listening_sync: true, ...capabilities } } : undefined,
  );
/** The server's flags back to none (the PUT path, as the mock starts). */
const noServerCaps = () =>
  (queryClient.getQueryData as jest.Mock).mockImplementation((k: readonly unknown[]) =>
    k?.[0] === 'server' ? { capabilities: {} } : undefined,
  );

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
    // The other device's record, read into the mirror (a downloaded book's page or its
    // download), is where the book is, not where this engine is.
    const read = { ...mirrorAt('2026-10-08T10:00:00Z', 400), device_id: 'other-device' };
    expect(placeToMoveTo({ ...base, mirror: read })).toBe(400);
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

  // FE-ANDROID-3: a record with no device id (a progress edit, an import, a PUT that named
  // none) is no listening device's, but a late place stands in for the start's own resume
  // lookup, which takes the newest record whoever wrote it.
  it('counts a record with no device id for a late place only', () => {
    const noDevice = record({ device_id: '' });
    expect(placeToMoveTo({ ...base, server: noDevice, late: true })).toBe(400);
    expect(placeToMoveTo({ ...base, server: noDevice, late: false })).toBeNull();
    // Still never with this device's id unknown, nor over a newer save of its own.
    expect(placeToMoveTo({ ...base, server: noDevice, late: true, deviceId: '' })).toBeNull();
    expect(
      placeToMoveTo({
        ...base,
        server: noDevice,
        late: true,
        mirror: mirrorAt('2026-10-08T10:00:01Z'),
      }),
    ).toBeNull();
    // Nor over a newer record the start read (another device's, or none's): the start's own
    // lookup took that one, the newest.
    for (const device_id of ['other-device', '']) {
      const read = { ...mirrorAt('2026-10-08T10:00:01Z', 105), device_id };
      expect(placeToMoveTo({ ...base, server: noDevice, late: true, mirror: read })).toBeNull();
    }
    expect(
      placeToMoveTo({
        ...base,
        server: noDevice,
        late: true,
        mirror: { ...mirrorAt('2026-10-08T09:00:00Z', 105), device_id: 'other-device' },
      }),
    ).toBe(400);
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
    // A lock-screen play: the engine plays before the check can answer.
    pushSnapshot(snap('playing', 106)); // auto-rewind and a second at the old place
    await usePlayer.getState().setRate(1.2); // a save while the check is out
    await settle();
    pushSnapshot(snap('playing', 400)); // the engine reports the move
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(saved().length).toBeGreaterThan(0);
    expect(saved().every((p) => p >= 400)).toBe(true);
  });

  describe('a Play press waits for the check before the engine starts (fe#158)', () => {
    const order = (fn: unknown) => (fn as jest.Mock).mock.invocationCallOrder[0];

    it('moves to the newer place before any of the old place sounds', async () => {
      await loadedAndPaused();
      jest.advanceTimersByTime(LONG_PAUSE_MS);
      await usePlayer.getState().toggle();
      expect(seeks()).toEqual([400]);
      expect(mockSvc.play).toHaveBeenCalledTimes(1);
      expect(order(mockSvc.seekTo)).toBeLessThan(order(mockSvc.play));
      // The play that follows is no second pick-up.
      pushSnapshot(snap('playing', 400));
      await settle();
      expect(mockClient.getProgress).toHaveBeenCalledTimes(1);
    });

    it('a slow check waits no longer than PICK_UP_WAIT_MS, then moves once it answers', async () => {
      await loadedAndPaused();
      let answer: (p: Progress) => void = () => {};
      mockServer = () => new Promise((resolve) => (answer = resolve));
      jest.advanceTimersByTime(LONG_PAUSE_MS);
      const press = usePlayer.getState().toggle();
      await settle();
      expect(mockSvc.play).not.toHaveBeenCalled();
      jest.advanceTimersByTime(PICK_UP_WAIT_MS);
      await press;
      expect(mockSvc.play).toHaveBeenCalledTimes(1);
      expect(seeks()).toEqual([]);
      pushSnapshot(snap('playing', 106));
      answer(record());
      await settle();
      expect(seeks()).toEqual([400]);
    });

    it('waits for a check already out (the app just came to the front), not past it', async () => {
      await loadedAndPaused();
      let answer: (p: Progress) => void = () => {};
      mockServer = () => new Promise((resolve) => (answer = resolve));
      jest.advanceTimersByTime(LONG_PAUSE_MS);
      await backInFront();
      expect(mockClient.getProgress).toHaveBeenCalledTimes(1);
      const press = usePlayer.getState().toggle();
      await settle();
      expect(mockSvc.play).not.toHaveBeenCalled();
      answer(record());
      await press;
      // One check, and the move it made came before the engine was asked to play.
      expect(mockClient.getProgress).toHaveBeenCalledTimes(1);
      expect(seeks()).toEqual([400]);
      expect(mockSvc.play).toHaveBeenCalledTimes(1);
      expect(order(mockSvc.seekTo)).toBeLessThan(order(mockSvc.play));
    });

    it('a pause while it waits stands: the engine never starts', async () => {
      await loadedAndPaused();
      let answer: (p: Progress) => void = () => {};
      mockServer = () => new Promise((resolve) => (answer = resolve));
      jest.advanceTimersByTime(LONG_PAUSE_MS);
      const press = usePlayer.getState().toggle();
      await settle();
      await usePlayer.getState().pause();
      answer(record({ device_id: 'this-device' }));
      await press;
      expect(mockSvc.play).not.toHaveBeenCalled();
    });

    it('a press paused while it waited leaves the book paused from then: the next long pause is a pick-up', async () => {
      await loadedAndPaused();
      let answer: (p: Progress) => void = () => {};
      mockServer = () => new Promise((resolve) => (answer = resolve));
      jest.advanceTimersByTime(LONG_PAUSE_MS);
      const press = usePlayer.getState().toggle();
      await settle();
      await usePlayer.getState().pause();
      answer(record({ device_id: 'this-device' }));
      await press;
      await settle();
      expect(mockClient.getProgress).toHaveBeenCalledTimes(1);
      // Another long pause, then Play: the check runs again before the engine starts.
      mockServer = async () => record();
      jest.advanceTimersByTime(LONG_PAUSE_MS);
      await usePlayer.getState().toggle();
      expect(mockClient.getProgress).toHaveBeenCalledTimes(2);
      expect(seeks()).toEqual([400]);
      expect(mockSvc.play).toHaveBeenCalledTimes(1);
    });

    it('shows the loading state while it waits, and a second tap there pauses: the old place never plays', async () => {
      await loadedAndPaused();
      let answer: (p: Progress) => void = () => {};
      mockServer = () => new Promise((resolve) => (answer = resolve));
      jest.advanceTimersByTime(LONG_PAUSE_MS);
      const press = usePlayer.getState().toggle();
      await settle();
      expect(usePlayer.getState().snapshot.state).toBe('loading');
      // The control is a spinner now: callers that play only a book not live leave it be.
      expect(selectIsTransportLive(usePlayer.getState())).toBe(true);
      // A second tap on the control is a tap on the spinner: the start is called off, and
      // the control is Play again at once, before the check answers.
      await usePlayer.getState().toggle();
      expect(usePlayer.getState().snapshot.state).toBe('paused');
      answer(record());
      await press;
      await settle();
      expect(mockSvc.play).not.toHaveBeenCalled();
      expect(usePlayer.getState().snapshot.state).toBe('paused');
    });

    it('a press while the wait is out waits for the same check, then plays the newer place', async () => {
      await loadedAndPaused();
      let answer: (p: Progress) => void = () => {};
      mockServer = () => new Promise((resolve) => (answer = resolve));
      jest.advanceTimersByTime(LONG_PAUSE_MS);
      const first = usePlayer.getState().toggle();
      await settle();
      await usePlayer.getState().pause();
      // Play again before the check answers: it waits for that check, not past it.
      const again = usePlayer.getState().toggle();
      await settle();
      expect(usePlayer.getState().snapshot.state).toBe('loading');
      expect(mockSvc.play).not.toHaveBeenCalled();
      answer(record());
      await Promise.all([first, again]);
      expect(mockClient.getProgress).toHaveBeenCalledTimes(1);
      expect(seeks()).toEqual([400]);
      expect(mockSvc.play).toHaveBeenCalledTimes(1);
      expect(order(mockSvc.seekTo)).toBeLessThan(order(mockSvc.play));
    });

    it('a press reaching the store while it waits (a stale caller) starts nothing of its own', async () => {
      await loadedAndPaused();
      let answer: (p: Progress) => void = () => {};
      mockServer = () => new Promise((resolve) => (answer = resolve));
      jest.advanceTimersByTime(LONG_PAUSE_MS);
      const first = usePlayer.getState().toggle();
      await settle();
      // A caller that read the book as paused before the wait began.
      usePlayer.setState({ snapshot: { ...usePlayer.getState().snapshot, state: 'paused' } });
      const second = usePlayer.getState().toggle();
      await settle();
      expect(mockSvc.play).not.toHaveBeenCalled();
      answer(record());
      await Promise.all([first, second]);
      expect(seeks()).toEqual([400]);
      expect(mockSvc.play).toHaveBeenCalledTimes(1);
      expect(order(mockSvc.seekTo)).toBeLessThan(order(mockSvc.play));
    });

    it('in the background nothing waits: the check runs once the engine plays', async () => {
      await loadedAndPaused();
      Object.defineProperty(AppState, 'currentState', {
        get: () => 'background',
        configurable: true,
      });
      mockServer = () => new Promise(() => {});
      jest.advanceTimersByTime(LONG_PAUSE_MS);
      await usePlayer.getState().toggle();
      expect(mockSvc.play).toHaveBeenCalledTimes(1);
      expect(mockClient.getProgress).not.toHaveBeenCalled();
      pushSnapshot(snap('playing', 105));
      await settle();
      expect(mockClient.getProgress).toHaveBeenCalledTimes(1);
      // The check gives up, so the next test starts with none out.
      jest.advanceTimersByTime(5_000);
      await settle();
    });
  });

  it("on the app coming back, asks the server only after the address runner's network check", async () => {
    await loadedAndPaused();
    const server = jest.fn(async () => record());
    mockServer = server;
    beginNetworkCheck(); // the app was away: the device may be on another network now
    await backInFront();
    expect(server).not.toHaveBeenCalled(); // no token out before a home pick is dropped
    endNetworkCheck();
    await settle();
    expect(server).toHaveBeenCalledTimes(1);
    expect(seeks()).toEqual([400]);
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

  it('names the chapter, with the time into that chapter, when the book has chapters', async () => {
    // The device pass: "Chapter 13, 1:22:00" (the book's time beside a chapter's name) read
    // as an impossible place in a six-minute chapter. 400 s is 1:40 into Chapter 2 (300-600).
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
      expect.objectContaining({ description: 'Chapter 2, 1:40' }),
    );
  });

  it('names the chapter by its title when a Prologue first makes the number contradict it', async () => {
    // The device pass: a book opening with a Prologue said "Chapter 4" for the chapter the
    // player shows as "Chapter 3" (the Resume labels' rule, `contradictedTitle`).
    const chapters = ['Prologue', 'Chapter 1', 'Chapter 2', 'Chapter 3'].map((title, i) => ({
      index: i,
      title,
      file_index: 0,
      file_path: 'A/Book.m4b',
      start: i * 120,
      end: (i + 1) * 120,
      book_offset: i * 120,
    }));
    mockLoadInitialProgress.mockResolvedValueOnce({ kind: 'empty' });
    await usePlayer.getState().playBook('c1', 2, { ...BOOK, chapters }, undefined);
    pushSnapshot(snap('playing', 100));
    pushSnapshot(snap('paused', 105));
    await settle();
    await backInFront();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Chapter 3, 0:40' }),
    );
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Chapter 4, 0:40' }),
    );
  });

  it('a paused book moved across a file boundary stays paused, with no save loop', async () => {
    // The device pass: after a pick-up moved a paused book on the Pixel, the mini player
    // showed Pause for 20+ s. The store side of that: a paused move into another file
    // (`skipToTrack`, which Android reports as a buffer and then a pause) must settle on
    // `paused`, so the play button reads Play and nothing saves on a timer.
    const files = ['A/1.mp3', 'A/2.mp3'].map((rel_path, seq) => ({
      rel_path,
      seq,
      duration: 500,
      format: 'mp3',
      size: 1,
    }));
    (mockSvc.skipToTrack as jest.Mock).mockImplementationOnce(
      async (trackIndex: number, position: number) => {
        pushSnapshot({ ...mockPlayerSnapshot(), trackIndex, position, state: 'loading' });
        pushSnapshot({ ...mockPlayerSnapshot(), trackIndex, position, state: 'paused' });
      },
    );
    mockLoadInitialProgress.mockResolvedValueOnce({ kind: 'empty' });
    await usePlayer.getState().playBook('c1', 2, { ...BOOK, files }, undefined);
    pushSnapshot(snap('playing', 100));
    pushSnapshot(snap('paused', 105));
    await settle();
    mockServer = async () => record({ position: 700 });
    jest.clearAllMocks();
    await backInFront();
    expect(mockSvc.skipToTrack).toHaveBeenCalledWith(1, 200);
    const now = usePlayer.getState();
    expect(now.snapshot.state).toBe('paused');
    expect(selectIsPlaying(now)).toBe(false);
    expect(selectBookPosition(now)).toBe(700);
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(saved()).toEqual([]);
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

  it("moves on when the mirror holds the other device's record this device read", async () => {
    await loadedAndPaused();
    // The book page read the server's row for this downloaded book into the mirror.
    mockMirror = { ...mirrorAt('2026-10-08T10:00:00Z', 400), device_id: 'other-device' };
    await backInFront();
    expect(seeks()).toEqual([400]);
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

// The review: a downloaded book whose server answered after the start's wait began from this
// device's older place and stayed there until the next place check.
describe('a downloaded book whose server answered only after it started', () => {
  /** Started from this device's place (100 s) while the server's read was still out; it
   * plays on, saving that older place meanwhile (the mirror's newest own save). Returns the
   * late answer's settle. */
  async function startedWithoutItsServer() {
    let answer: (late: LatePlace | null) => void = () => {};
    const late = new Promise<LatePlace | null>((resolve) => (answer = resolve));
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'progress',
      progress: record({
        position: 100,
        version: 0,
        device_id: 'this-device',
        updated_at: '2026-10-08T09:00:00Z',
      }),
      unchecked: true,
      late,
    });
    await usePlayer.getState().playBook('c1', 2, BOOK, undefined);
    pushSnapshot(snap('playing', 100));
    await settle();
    mockMirror = mirrorAt('2026-10-08T12:00:00Z', 110);
    jest.clearAllMocks();
    // The mirror as the start read it: this device's save from before the other device's.
    return (server = record()) => answer({ server, mirror: mirrorAt('2026-10-08T09:00:00Z', 100) });
  }

  it("moves to another device's newer place when the answer comes, and says so with Undo", async () => {
    const answer = await startedWithoutItsServer();
    expect(seeks()).toEqual([]);
    answer();
    await settle();
    expect(seeks()).toEqual([400]);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Picked up your place from another device',
        action: expect.objectContaining({ label: 'Undo' }),
      }),
    );
    expect(mockAckVersion).toHaveBeenCalledWith('c1', 2, 'A/Book.m4b', 3, expect.anything());
  });

  it("the listener's own seek made meanwhile wins", async () => {
    const answer = await startedWithoutItsServer();
    await usePlayer.getState().seekBook(700);
    answer();
    await settle();
    expect(seeks()).toEqual([700]);
    expect(mockToast).not.toHaveBeenCalled();
  });

  // The review: Stay on an offer of the same row (the sync's answer) made meanwhile was
  // overruled by the late answer's move.
  it('an offer of the same row answered meanwhile stands: no move', async () => {
    const answer = await startedWithoutItsServer();
    mockMirror = { ...mirrorAt('2026-10-08T12:00:00Z', 110), ack_version: 3 };
    answer();
    await settle();
    expect(seeks()).toEqual([]);
    expect(mockToast).not.toHaveBeenCalled();
  });

  // FE-ANDROID-3 (a device run): the server's newer row had no device id (a PUT that named
  // none), and the late answer neither moved the book nor offered it.
  it('moves to a newer place with no device id, as the start would have resumed it', async () => {
    const answer = await startedWithoutItsServer();
    answer(record({ device_id: '' }));
    await settle();
    expect(seeks()).toEqual([400]);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Picked up your place from another device' }),
    );
  });

  it('offers an older place with no device id on a listening_sync server, as an unknown device', async () => {
    serverCaps({});
    try {
      const answer = await startedWithoutItsServer();
      answer(record({ device_id: '', version: 4, updated_at: '2026-10-08T08:00:00Z' }));
      await settle();
      expect(seeks()).toEqual([]);
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'On another device you were at 6:40. Jump there?' }),
      );
    } finally {
      noServerCaps();
    }
  });

  it('a book that played to its end meanwhile stays there', async () => {
    const answer = await startedWithoutItsServer();
    pushSnapshot(snap('ended', 1000));
    await settle();
    answer();
    await settle();
    expect(seeks()).toEqual([]);
    expect(mockToast).not.toHaveBeenCalled();
  });

  // The review: a late answer and a check's that came in the same tick each moved from the
  // place before the other's move: two moves, and two "Picked up" toasts.
  it("a check's answer in the same tick is one move, to the newest place", async () => {
    const answerLate = await startedWithoutItsServer();
    let answerCheck: (row: Progress | null) => void = () => {};
    mockServer = () => new Promise((resolve) => (answerCheck = resolve));
    const check = reconcileLoadedPlace('picked-up');
    await settle();
    answerLate();
    answerCheck(record({ position: 600, version: 4, updated_at: '2026-10-08T12:30:00Z' }));
    await check;
    await settle(24);
    expect(seeks()).toEqual([600]);
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  // The review: an older check's answer that the late one replaced in the same tick read
  // as no move, so the check let its held saves go with the place before the late one's move,
  // dated now: this device's old place over the other device's on the server.
  it("a check's older answer in the same tick waits for the newer one's move", async () => {
    const answerLate = await startedWithoutItsServer();
    let answerCheck: (row: Progress | null) => void = () => {};
    mockServer = () => new Promise((resolve) => (answerCheck = resolve));
    const check = reconcileLoadedPlace('picked-up');
    await settle();
    mockSaveProgress.mockClear();
    answerLate();
    answerCheck(record({ position: 300, version: 2, updated_at: '2026-10-08T09:30:00Z' }));
    await check;
    await settle(24);
    expect(seeks()).toEqual([400]);
    expect(saved()).not.toContain(100);
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  // The review: the same row from both in one tick was decided as whichever came second
  // weighed it. As the check's (this device's record now, which holds the session's own
  // saves of the place it started from, newer than the row), the book stayed where it was.
  it.each([
    ['the late answer first', true],
    ["the check's answer first", false],
  ])('the same row from both in one tick moves once, %s', async (_name, lateFirst) => {
    const answerLate = await startedWithoutItsServer();
    let answerCheck: (row: Progress | null) => void = () => {};
    mockServer = () => new Promise((resolve) => (answerCheck = resolve));
    const check = reconcileLoadedPlace('picked-up');
    await settle();
    if (lateFirst) answerLate();
    answerCheck(record());
    if (!lateFirst) answerLate();
    await check;
    await settle(24);
    expect(seeks()).toEqual([400]);
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  // The review: a start whose server answered late kept guarding its saves (fe#198), each
  // read against the server's row first, though the answer had checked its place.
  describe('the replay guard', () => {
    const lastGuard = () =>
      (mockSaveProgress.mock.calls.at(-1)?.[1] as { guard?: boolean } | undefined)?.guard;

    async function savedAfter(row: Progress, meanwhile?: () => Promise<void>) {
      let answer: (late: LatePlace | null) => void = () => {};
      mockLoadInitialProgress.mockResolvedValueOnce({
        kind: 'progress',
        progress: record({ position: 100, version: 0, device_id: 'this-device' }),
        unchecked: true,
        late: new Promise<LatePlace | null>((resolve) => (answer = resolve)),
      });
      await usePlayer.getState().playBook('c1', 2, BOOK, undefined);
      pushSnapshot(snap('playing', 100));
      await settle();
      jest.clearAllMocks();
      await meanwhile?.();
      answer({ server: row, mirror: mirrorAt('2026-10-08T09:00:00Z', 100) });
      await settle(24);
      mockSaveProgress.mockClear();
      pushSnapshot(snap('playing', 130));
      jest.advanceTimersByTime(15_000);
      await settle();
    }

    it('goes once the late answer holds nothing further on', async () => {
      await savedAfter(record({ position: 90, device_id: 'this-device' }));
      expect(mockSaveProgress).toHaveBeenCalled();
      expect(lastGuard()).toBeFalsy();
    });

    it("stays when the answer holds another device's place the book stayed short of", async () => {
      // The listener's own seek meanwhile wins: the book stays short of the other device's.
      await savedAfter(record({ position: 900 }), () => usePlayer.getState().seekBook(120));
      expect(seeks()).toEqual([120]);
      expect(lastGuard()).toBe(true);
    });
  });

  it('stays when the server holds nothing newer of another device', async () => {
    let answer: (late: LatePlace | null) => void = () => {};
    mockLoadInitialProgress.mockResolvedValueOnce({
      kind: 'empty',
      late: new Promise<LatePlace | null>((resolve) => (answer = resolve)),
    });
    await usePlayer.getState().playBook('c1', 2, BOOK, undefined);
    pushSnapshot(snap('playing', 0));
    await settle();
    jest.clearAllMocks();
    answer({ server: record({ device_id: 'this-device' }), mirror: null });
    await settle();
    expect(seeks()).toEqual([]);
    expect(mockToast).not.toHaveBeenCalled();
  });
});

// --- Sync v2 (`listening_sync`): another device's place offered, never moved to ----------

describe('offerOf', () => {
  const other = {
    position: 900,
    device_id: 'watch',
    device_name: "Chris's Watch",
    updated_at: '2026-10-08T11:00:00Z',
  };

  it("(a) offers the kept row of another device at a version this device hasn't seen", () => {
    expect(offerOf(record({ device_name: 'Pixel', version: 4 }), 'this-device', 3, 105)).toEqual({
      position: 400,
      deviceName: 'Pixel',
      key: 'other-device|2026-10-08T10:00:00Z',
    });
    // Acknowledged already, this device's own row, finished, or within 30 s: nothing.
    expect(offerOf(record({ version: 3 }), 'this-device', 3, 105)).toBeNull();
    expect(offerOf(record({ device_id: 'this-device' }), 'this-device', 0, 105)).toBeNull();
    expect(offerOf(record({ finished: true }), 'this-device', 0, 105)).toBeNull();
    expect(offerOf(record(), 'this-device', 0, 371)).toBeNull();
    expect(offerOf(record(), 'this-device', 0, 369)?.position).toBe(400);
    // No name known: the caller says "another device".
    expect(offerOf(record(), 'this-device', undefined, 105)?.deviceName).toBe('');
  });

  it("(b) else the row's other_place of another device, until answered", () => {
    const row = record({ device_id: 'this-device', position: 400, other_place: other });
    expect(offerOf(row, 'this-device', 3, 400)).toEqual({
      position: 900,
      deviceName: "Chris's Watch",
      key: 'watch|2026-10-08T11:00:00Z',
    });
    expect(offerOf(row, 'this-device', 3, 400, ['watch|2026-10-08T11:00:00Z'])).toBeNull();
    // This device's own losing place is no offer; a near one isn't either.
    expect(
      offerOf(
        { ...row, other_place: { ...other, device_id: 'this-device' } },
        'this-device',
        3,
        400,
      ),
    ).toBeNull();
    expect(offerOf(row, 'this-device', 3, 880)).toBeNull();
    // (a) wins over (b); answered (a) falls back to (b).
    const both = record({ version: 9, other_place: other });
    expect(offerOf(both, 'this-device', 3, 105)?.position).toBe(400);
    expect(
      offerOf(both, 'this-device', 3, 105, ['other-device|2026-10-08T10:00:00Z'])?.position,
    ).toBe(900);
    expect(offerOf(null, 'this-device', 3, 105)).toBeNull();
  });

  it('offers a place with no device id only as a late place, as an unknown device', () => {
    const noDevice = record({ device_id: '', version: 4 });
    expect(offerOf(noDevice, 'this-device', 3, 105)).toBeNull();
    expect(offerOf(noDevice, 'this-device', 3, 105, [], true)).toEqual({
      position: 400,
      deviceName: '',
      key: '|2026-10-08T10:00:00Z',
    });
    expect(offerOf(noDevice, '', 3, 105, [], true)).toBeNull();
    expect(offerOf(noDevice, 'this-device', 3, 105, ['|2026-10-08T10:00:00Z'], true)).toBeNull();
  });
});

describe('on a server with listening_sync', () => {
  beforeEach(() => serverCaps({}));
  afterEach(noServerCaps);

  type Toast = {
    title: string;
    action: { onPress: () => void };
    onClose: () => void;
    onTimeout: () => void;
    closeLabel: string;
  };
  const lastToast = () => mockToast.mock.calls[mockToast.mock.calls.length - 1][0] as Toast;

  it("offers the other_place the server didn't keep, and Jump moves there acknowledged", async () => {
    await loadedAndPaused();
    // The row is this device's (no auto-move); the watch's place lost and is kept beside it.
    mockServer = async () =>
      record({
        device_id: 'this-device',
        position: 105,
        version: 7,
        other_place: {
          position: 640,
          device_id: 'watch',
          device_name: "Chris's Watch",
          updated_at: '2026-10-08T11:00:00Z',
        },
      });
    await backInFront();
    expect(seeks()).toEqual([]);
    const offer = lastToast();
    expect(offer.title).toBe("On Chris's Watch you were at 10:40. Jump there?");
    expect(offer.closeLabel).toBe('Stay');
    offer.action.onPress();
    await settle();
    expect(mockAckVersion).toHaveBeenCalledWith('c1', 2, 'A/Book.m4b', 7, expect.anything());
    expect(mockMarkAnswered).toHaveBeenCalledWith(
      'c1',
      2,
      'A/Book.m4b',
      'watch|2026-10-08T11:00:00Z',
      expect.anything(),
    );
    expect(seeks()).toEqual([640]);
  });

  it('Stay acknowledges and stays; the same offer is not shown again', async () => {
    await loadedAndPaused();
    mockServer = async () =>
      record({
        device_id: 'this-device',
        position: 105,
        version: 8,
        other_place: {
          position: 700,
          device_id: 'watch2',
          device_name: '',
          updated_at: '2026-10-08T11:30:00Z',
        },
      });
    await backInFront();
    const offer = lastToast();
    expect(offer.title).toBe('On another device you were at 11:40. Jump there?');
    offer.onClose();
    await settle();
    expect(mockAckVersion).toHaveBeenCalledWith('c1', 2, 'A/Book.m4b', 8, expect.anything());
    expect(seeks()).toEqual([]);
    mockToast.mockClear();
    await backInFront();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('an offer nobody answers is noted when its toast times out, with nothing acknowledged', async () => {
    await loadedAndPaused();
    mockServer = async () =>
      record({
        device_id: 'this-device',
        position: 105,
        version: 8,
        other_place: {
          position: 700,
          device_id: 'watch3',
          device_name: 'Watch',
          updated_at: '2026-10-08T11:40:00Z',
        },
      });
    await backInFront();
    mockAckVersion.mockClear();
    lastToast().onTimeout();
    await settle();
    expect(mockIgnoreOffer).toHaveBeenCalledWith(
      'c1',
      2,
      'A/Book.m4b',
      expect.objectContaining({ version: 8 }),
      'watch3|2026-10-08T11:40:00Z',
    );
    expect(mockAckVersion).not.toHaveBeenCalled();
    expect(seeks()).toEqual([]);
  });

  it('a device playing on is offered once in OFFER_REPEAT_MS, not with each place it sends', async () => {
    await loadedAndPaused();
    const playingOn = (updated_at: string, position: number) => async () =>
      record({
        device_id: 'this-device',
        position: 105,
        version: 9,
        other_place: { position, device_id: 'tablet', device_name: 'Tablet', updated_at },
      });
    mockServer = playingOn('2026-10-08T11:50:00Z', 800);
    await backInFront();
    expect(mockToast).toHaveBeenCalledTimes(1);
    // Its next span moved the place on: a new key, but the same device a moment later.
    mockServer = playingOn('2026-10-08T11:50:15Z', 815);
    await backInFront();
    expect(mockToast).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() + OFFER_REPEAT_MS);
    mockServer = playingOn('2026-10-08T12:00:15Z', 900);
    await backInFront();
    expect(mockToast).toHaveBeenCalledTimes(2);
  });

  // Stay wins (row 9c-2): this device's Stay came back held (`diverged`, `kept: stored`: the
  // other device's own Stay holds the row), so the place kept is offered at once, not
  // OFFER_REPEAT_MS after that device's first offer; a span held otherwise waits for it.
  describe('a Stay the server held', () => {
    const stayServer = (stay: boolean) => serverCaps({ listening_stay: stay });
    // Every batch held: the paused play's span may go in one of its own first.
    const applied = mockClient.syncListening.getMockImplementation();
    afterEach(() => mockClient.syncListening.mockImplementation(applied));
    const heldAnswer = (device: string) =>
      mockClient.syncListening.mockImplementation(async (body: { events: { id: string }[] }) => ({
        server_time: '',
        results: body.events.map((e) => ({ id: e.id, status: 'diverged', kept: 'stored' })),
        progress: [
          record({
            device_id: device,
            device_name: 'Phone B',
            position: 720,
            version: 9,
            updated_at: '2026-10-08T11:59:50Z',
          }),
        ],
      }));
    const stayOnOffer = async (device: string) => {
      await loadedAndPaused();
      mockServer = async () =>
        record({
          device_id: 'this-device',
          position: 105,
          version: 8,
          other_place: {
            position: 700,
            device_id: device,
            device_name: 'Phone B',
            updated_at: '2026-10-08T11:45:00Z',
          },
        });
      await backInFront();
      expect(mockToast).toHaveBeenCalledTimes(1);
      // The Stay acknowledged the row it answered.
      mockMirror = { ...mockMirror!, ack_version: 8 };
      heldAnswer(device);
      lastToast().onClose();
      for (let i = 0; i < 10; i++) await settle();
      const sent = mockClient.syncListening.mock.calls.flatMap(
        (c) => (c[0] as { events: { start?: string }[] }).events,
      );
      return sent.map((e) => e.start);
    };

    it('offers the place the other Stay kept at once', async () => {
      stayServer(true);
      // With the paused play's span still waiting before it.
      expect(await stayOnOffer('phone-b')).toEqual(['resume', 'stay']);
      expect(mockToast).toHaveBeenCalledTimes(2);
      expect(lastToast().title).toBe('On Phone B you were at 12:00. Jump there?');
    });

    it('a jump held the same way waits OFFER_REPEAT_MS for its offer', async () => {
      stayServer(false);
      expect(await stayOnOffer('phone-c')).toEqual(['resume', 'jump']);
      expect(mockToast).toHaveBeenCalledTimes(1);
    });
  });

  it("another device's newer row still moves the book with Undo (placeToMoveTo unchanged)", async () => {
    await loadedAndPaused();
    await backInFront();
    expect(seeks()).toEqual([400]);
    // The row it moved to is acknowledged.
    expect(mockAckVersion).toHaveBeenCalledWith('c1', 2, 'A/Book.m4b', 3, expect.anything());
  });
});

// fe#198: on the legacy PUT path a guarded save that another device's further place held
// back offers that place, with the same toast; Stay lets this device's place through.
describe('a save the replay guard held back (the PUT path)', () => {
  type Toast = {
    title: string;
    action: { onPress: () => void };
    onClose: () => void;
    onTimeout: () => void;
  };
  const lastToast = () => mockToast.mock.calls[mockToast.mock.calls.length - 1][0] as Toast;
  const heldSave = (over: Partial<ProgressSave> = {}): ProgressSave => ({
    ...mirrorAt('2026-10-08T11:55:00Z', 105),
    guard: true,
    ...over,
  });
  const further = (device: string) =>
    record({ position: 640, device_id: device, device_name: 'Phone', version: 12 });
  // A server without listening_sync: an earlier test's sync answer told the outbox c1 has
  // it (kept in memory and in the sync state), and its events are still stored.
  beforeEach(async () => {
    await AsyncStorage.clear();
    resetOutboxForTests();
  });

  it('offers the place that held it; Stay notes the answer and saves this place at once', async () => {
    await loadedAndPaused();
    mockHeld?.(heldSave(), further('held-1'), mockMirror);
    await settle();
    const offer = lastToast();
    expect(offer.title).toBe('On Phone you were at 10:40. Jump there?');
    offer.onClose();
    await settle();
    expect(mockMarkAnswered).toHaveBeenCalledWith(
      'c1',
      2,
      'A/Book.m4b',
      'held-1|2026-10-08T10:00:00Z',
      expect.anything(),
    );
    expect(saved()).toEqual([105]);
    expect(seeks()).toEqual([]);
  });

  it('Jump moves there', async () => {
    await loadedAndPaused();
    mockHeld?.(heldSave(), further('held-2'), mockMirror);
    await settle();
    lastToast().action.onPress();
    await settle();
    expect(seeks()).toEqual([640]);
  });

  it('a toast nobody answers answers nothing: the place stays held', async () => {
    await loadedAndPaused();
    mockHeld?.(heldSave(), further('held-3'), mockMirror);
    await settle();
    lastToast().onTimeout();
    await settle();
    expect(mockIgnoreOffer).not.toHaveBeenCalled();
    expect(mockMarkAnswered).not.toHaveBeenCalled();
  });

  it('a held save of a book not loaded offers nothing', async () => {
    await loadedAndPaused();
    mockHeld?.(heldSave({ path: 'Another/Book.m4b' }), further('held-4'), mockMirror);
    await settle();
    expect(mockToast).not.toHaveBeenCalled();
  });
});
