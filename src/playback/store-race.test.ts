import type { Book } from '@/api/types';

import type { PlaybackService, PlaybackSnapshot } from './types';

// Two of the store's races with the native bridge (Phase 6): the bridge is created once
// however many callers race to the first, and a remote move reported while a book loads
// belongs to the previous queue.

let pushSnapshot: (s: PlaybackSnapshot) => void = () => {};
let remoteMove: ((trackIndex: number, positionInTrack: number) => void) | null = null;
const INITIAL: PlaybackSnapshot = {
  state: 'idle',
  trackIndex: 0,
  position: 0,
  duration: 0,
  rate: 1,
};
let finishSetup: () => void = () => {};
const mockSvc = {
  onRemoteSeek: jest.fn(),
  onRemoteMove: jest.fn((h: typeof remoteMove) => {
    remoteMove = h;
  }),
  setup: jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finishSetup = resolve;
      }),
  ),
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

const mockCreate = jest.fn(() => mockSvc);
jest.mock('./service', () => ({ createPlaybackService: () => mockCreate() }));

const mockSaveProgress = jest.fn(async (..._args: unknown[]) => {});
jest.mock('./progress-sync', () => ({
  saveProgress: (...args: unknown[]) => mockSaveProgress(...args),
  // This device's own record between two saves (`placeLoop`).
  writeMirror: jest.fn(async () => {}),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
  loadInitialProgress: jest.fn(async () => ({ kind: 'empty' })),
  readMirror: jest.fn(async () => null),
}));
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
const mockClient = {
  coverUrl: (lib: number, path: string) => `cover:${lib}:${path}`,
  streamUrl: (lib: number, path: string) => `stream:${lib}:${path}`,
  authHeaders: () => ({ Authorization: 'Bearer x' }),
  addHistory: jest.fn(async () => {}),
};
jest.mock('@/api/connection-clients', () => ({
  resolveClient: () => mockClient,
  sessionReady: jest.fn(() => true),
}));

/* eslint-disable import/first */
import { usePlayer } from './store';
/* eslint-enable import/first */

const book = (path: string, duration = 100): Book => ({
  id: 1,
  library_id: 2,
  rel_path: path,
  is_folder: false,
  title: path,
  author: 'Author',
  series: '',
  series_index: 0,
  narrator: '',
  duration,
  format: 'm4b',
  size: 0,
});

async function flush(turns = 10) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe('the native bridge', () => {
  it('is created once however many callers race to the first', async () => {
    const a = usePlayer.getState().toggle();
    const b = usePlayer.getState().toggle();
    await flush();
    finishSetup();
    await Promise.all([a, b]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockSvc.setup).toHaveBeenCalledTimes(1);
    expect(mockSvc.subscribe).toHaveBeenCalledTimes(1);
  });

  it("ignores a remote move reported while a book loads (it is the previous queue's)", async () => {
    // Book A plays, file 2 of 3 (100 s each).
    const startingA = usePlayer.getState().playBook('c1', 2, book('A', 300), {
      library_id: 2,
      path: 'A',
      duration: 300,
      is_folder: true,
      files: [0, 1, 2].map((i) => ({
        rel_path: `A/${i}.mp3`,
        seq: i,
        duration: 100,
        format: 'mp3',
        size: 1,
      })),
      chapters: [],
    });
    await flush();
    finishSetup(); // the bridge's setup, when this test runs on its own
    await startingA;
    pushSnapshot({ state: 'playing', trackIndex: 1, position: 40, duration: 100, rate: 1 });
    // B starts and its load is still out when A's late move arrives (file 2, 70 s).
    let landed!: () => void;
    (mockSvc.load as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          landed = resolve;
        }),
    );
    const starting = usePlayer.getState().playBook('c1', 2, book('B'), undefined, 50);
    await flush(30);
    expect(usePlayer.getState().loadingBook).not.toBeNull();
    mockSaveProgress.mockClear();
    remoteMove?.(2, 70);
    await flush();
    expect(mockSaveProgress).not.toHaveBeenCalled();
    landed();
    await starting;
  });
});

// FE-13: a car play whose native wait ran out while a slow server held its start. Android had
// released that start's foreground service, so a play then was heard with no notification.
describe('a start that is no longer wanted', () => {
  it('loads the book paused: it never plays, and no stall error follows', async () => {
    jest.useFakeTimers();
    try {
      let wanted = true;
      let landed!: () => void;
      (mockSvc.load as jest.Mock).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            landed = resolve;
          }),
      );
      (mockSvc.play as jest.Mock).mockClear();
      (mockSvc.pause as jest.Mock).mockClear();
      const starting = usePlayer
        .getState()
        .playBook('c1', 2, book('Late'), undefined, 10, undefined, undefined, () => wanted);
      await flush(30);
      finishSetup(); // the bridge's setup, when this test runs on its own
      await flush(30);
      expect(mockSvc.load).toHaveBeenCalled();
      wanted = false;
      landed();
      await starting;
      expect(mockSvc.play).not.toHaveBeenCalled();
      // Paused outright: an engine still set to play (the queue it replaced, or Media3's play
      // after a failed resumption) would otherwise start it as it loads.
      expect(mockSvc.pause).toHaveBeenCalled();
      expect(usePlayer.getState().nowPlaying?.path).toBe('Late');
      // The stall watchdog was disarmed with the intent: the engine's idle report stays a
      // paused book, never an error.
      pushSnapshot({ state: 'ready', trackIndex: 0, position: 10, duration: 100, rate: 1 });
      await jest.advanceTimersByTimeAsync(10_000);
      expect(usePlayer.getState().snapshot.state).not.toBe('error');
    } finally {
      jest.useRealTimers();
    }
  });

  // Called off for another play (a tap on another book in the car) while its place was still
  // looked up: loaded then, it replaced the book that play had started, paused.
  it('loads nothing over a start made since', async () => {
    const { loadInitialProgress } = jest.requireMock('./progress-sync') as {
      loadInitialProgress: jest.Mock;
    };
    let answer!: (v: unknown) => void;
    loadInitialProgress.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    let wanted = true;
    const late = usePlayer
      .getState()
      .playBook(
        'c1',
        2,
        book('CalledOff'),
        undefined,
        undefined,
        undefined,
        undefined,
        () => wanted,
      );
    await flush(30);
    finishSetup(); // the bridge's setup, when this test runs on its own
    await flush(30);
    await usePlayer.getState().playBook('c1', 2, book('Instead'), undefined, 10);
    (mockSvc.load as jest.Mock).mockClear();
    (mockSvc.pause as jest.Mock).mockClear();
    wanted = false;
    answer({ kind: 'empty' });
    await late;
    expect(mockSvc.load).not.toHaveBeenCalled();
    expect(mockSvc.pause).not.toHaveBeenCalled();
    expect(usePlayer.getState().nowPlaying?.path).toBe('Instead');
    // Stopped, so no watchdog or save loop outlives the test.
    await usePlayer.getState().stop();
  });

  // Called off while its place was looked up, the player still its own: the engine is set
  // not to play before the load, so the downloaded book is never heard for a moment.
  it('pauses the engine before the load when called off before it', async () => {
    const { loadInitialProgress } = jest.requireMock('./progress-sync') as {
      loadInitialProgress: jest.Mock;
    };
    let answer!: (v: unknown) => void;
    loadInitialProgress.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    let wanted = true;
    const late = usePlayer
      .getState()
      .playBook('c1', 2, book('Early'), undefined, undefined, undefined, undefined, () => wanted);
    await flush(30);
    finishSetup(); // the bridge's setup, when this test runs on its own
    await flush(30);
    const load = mockSvc.load as jest.Mock;
    const pause = mockSvc.pause as jest.Mock;
    load.mockClear();
    pause.mockClear();
    (mockSvc.play as jest.Mock).mockClear();
    wanted = false;
    answer({ kind: 'empty' });
    await late;
    expect(load).toHaveBeenCalled();
    expect(pause.mock.invocationCallOrder[0]).toBeLessThan(load.mock.invocationCallOrder[0]);
    expect(mockSvc.play).not.toHaveBeenCalled();
    await usePlayer.getState().stop();
  });

  // Called off for a play native made in its place (fe#350: the car's tap on the book the
  // player already holds, the last tap wins), no other start made here: the player is that
  // play's, so this one loads nothing over it, not even paused.
  it('loads nothing when native played another book in its place', async () => {
    const { loadInitialProgress } = jest.requireMock('./progress-sync') as {
      loadInitialProgress: jest.Mock;
    };
    let answer!: (v: unknown) => void;
    loadInitialProgress.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    let wanted = true;
    let superseded = false;
    const late = usePlayer.getState().playBook(
      'c1',
      2,
      book('GaveWay'),
      undefined,
      undefined,
      undefined,
      undefined,
      () => wanted,
      () => superseded,
    );
    await flush(30);
    finishSetup(); // the bridge's setup, when this test runs on its own
    await flush(30);
    const load = mockSvc.load as jest.Mock;
    load.mockClear();
    (mockSvc.play as jest.Mock).mockClear();
    wanted = false;
    superseded = true;
    answer({ kind: 'empty' });
    await late;
    expect(load).not.toHaveBeenCalled();
    expect(mockSvc.play).not.toHaveBeenCalled();
    await usePlayer.getState().stop();
  });

  it('plays as before while it is wanted', async () => {
    (mockSvc.play as jest.Mock).mockClear();
    (mockSvc.pause as jest.Mock).mockClear();
    await usePlayer
      .getState()
      .playBook('c1', 2, book('Wanted'), undefined, 10, undefined, undefined, () => true);
    expect(mockSvc.play).toHaveBeenCalled();
    expect(mockSvc.pause).not.toHaveBeenCalled();
    // Stopped, so no watchdog or save loop outlives the test.
    await usePlayer.getState().stop();
  });
});
