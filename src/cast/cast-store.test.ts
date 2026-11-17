import type { Book, ChaptersResponse } from '@/api/types';
import { INITIAL_SNAPSHOT, type PlaybackService, type PlaybackSnapshot } from '@/playback/types';

// The REAL player store driving a cast through the route switch (decision 7: the store is
// unchanged and never knows it is casting). The phone's engine is a fake; the cast engine is
// the real `CastPlaybackService` over a fake receiver.

function mockEngine() {
  let snap: PlaybackSnapshot = { ...INITIAL_SNAPSHOT };
  const listeners = new Set<(s: PlaybackSnapshot) => void>();
  const emit = (patch: Partial<PlaybackSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const l of listeners) l(snap);
  };
  const engine = {
    emit,
    setup: jest.fn(async () => {}),
    configure: jest.fn(async () => {}),
    load: jest.fn(async (_t: unknown, index: number, position: number) => {
      emit({ state: 'ready', trackIndex: index, position });
    }),
    play: jest.fn(async () => emit({ state: 'playing' })),
    pause: jest.fn(async () => emit({ state: 'paused' })),
    seekTo: jest.fn(async (position: number) => emit({ position })),
    skipToTrack: jest.fn(async (trackIndex: number, position = 0) =>
      emit({ trackIndex, position }),
    ),
    setRate: jest.fn(async (rate: number) => emit({ rate })),
    setVolume: jest.fn(async () => {}),
    reset: jest.fn(async () => emit({ ...INITIAL_SNAPSHOT, rate: snap.rate })),
    getSnapshot: () => snap,
    subscribe: (l: (s: PlaybackSnapshot) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return engine;
}
const mockLocal = mockEngine();

jest.mock('@/playback/service', () => ({
  createPlaybackService: () =>
    jest.requireActual('@/cast/routed-service').routed(mockLocal as unknown as PlaybackService),
}));

const mockSaveProgress = jest.fn(async (..._args: unknown[]) => {});
const mockLoadInitial = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({
  kind: 'empty',
}));
jest.mock('@/playback/progress-sync', () => ({
  saveProgress: (...args: unknown[]) => mockSaveProgress(...args),
  flushQueue: jest.fn(async () => {}),
  flushConnection: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
  loadInitialProgress: (...args: unknown[]) => mockLoadInitial(...args),
  readMirror: jest.fn(async () => null),
}));
jest.mock('@/api/provider', () => ({
  queryClient: {
    invalidateQueries: jest.fn(),
    setQueryData: jest.fn(),
    // A server without listening_sync: the place is saved by PUT.
    getQueryData: jest.fn((k: readonly unknown[]) =>
      k?.[0] === 'server' ? { capabilities: {} } : undefined,
    ),
    fetchQuery: jest.fn(async () => ({})),
  },
}));
jest.mock('@/lib/network', () => ({ canAutoDownload: jest.fn(async () => false) }));
const mockClient = {
  coverUrl: (lib: number, path: string) => `cover:${lib}:${path}`,
  streamUrl: (lib: number, path: string) => `stream:${lib}:${path}?token=SESSION`,
  authHeaders: () => ({ Authorization: 'Bearer x' }),
  addHistory: jest.fn(async () => {}),
};
jest.mock('@/api/connection-clients', () => ({
  resolveClient: () => mockClient,
  sessionReady: () => true,
}));

/* eslint-disable import/first */
import { initializePlayback, usePlayer } from '@/playback/store';

import { buildCastItems } from './cast-media';
import { CastPlaybackService } from './cast-service';
import { currentRouter } from './routed-service';
import type { CastMediaStatus, CastQueueLoad, CastRemote } from './types';
/* eslint-enable import/first */

const book: Book = {
  id: 1,
  library_id: 2,
  rel_path: 'B',
  is_folder: true,
  title: 'B',
  author: 'Author',
  series: '',
  series_index: 0,
  narrator: '',
  duration: 200,
  format: 'mp3',
  size: 0,
};
const chapters: ChaptersResponse = {
  library_id: 2,
  path: 'B',
  duration: 200,
  is_folder: true,
  files: [
    { rel_path: 'B/1.mp3', seq: 0, duration: 100, format: 'mp3', size: 1 },
    { rel_path: 'B/2.mp3', seq: 1, duration: 100, format: 'mp3', size: 1 },
  ],
  chapters: [],
};

function fakeReceiver() {
  let onStatus: ((s: CastMediaStatus | null) => void) | null = null;
  const loads: CastQueueLoad[] = [];
  const remote: CastRemote = {
    load: jest.fn(async (r: CastQueueLoad) => {
      loads.push(r);
    }),
    play: jest.fn(async () => {}),
    pause: jest.fn(async () => {}),
    seek: jest.fn(async () => {}),
    setRate: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    readStatus: jest.fn(async () => null),
    onStatus: (h) => {
      onStatus = h;
      return () => {};
    },
    onProgress: () => () => {},
  };
  const urls = {
    streamUrl: (lib: number, path: string) => `https://h/${lib}/${path}?token=CAST`,
    coverUrl: () => 'https://h/cover?token=CAST',
  };
  const cast = new CastPlaybackService(remote, async (tracks, b) => ({
    items: buildCastItems(tracks, b, urls, false),
  }));
  return {
    cast,
    remote,
    loads,
    status: (s: Partial<CastMediaStatus>) =>
      onStatus?.({ playerState: 'playing', position: 0, rate: 1, ...s }),
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('the store, casting through the route switch', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSaveProgress.mockClear();
  });
  afterEach(() => jest.useRealTimers());

  it('saves the place on handover, plays on the receiver, and saves the receiver place on the way back', async () => {
    await usePlayer.getState().playBook('c1', 2, book, chapters, 150);
    await flush();
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', trackIndex: 1 });
    mockLocal.emit({ position: 60 });

    const rx = fakeReceiver();
    await currentRouter()!.beginCast(rx.cast);
    await flush();
    // The handover read as a pause at the place: saved (whole-book 160).
    expect(mockSaveProgress).toHaveBeenLastCalledWith(
      mockClient,
      expect.objectContaining({ path: 'B', position: 160 }),
    );
    // The receiver got the book at that place, with the cast token, and plays.
    expect(rx.loads[0]).toMatchObject({ startIndex: 1, startTime: 60 });
    expect(rx.loads[0].items[1].url).toBe('https://h/2/B/2.mp3?token=CAST');
    expect(rx.remote.play).toHaveBeenCalled();
    rx.status({
      playerState: 'playing',
      contentId: 'https://h/2/B/2.mp3?token=CAST',
      position: 61,
    });
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', position: 61 });

    // No stall error: the store's watchdog was never armed by the handover.
    jest.advanceTimersByTime(4_000);
    expect(usePlayer.getState().snapshot.state).toBe('playing');

    // The store drives the receiver: pause, seek, speed.
    await usePlayer.getState().toggle();
    expect(rx.remote.pause).toHaveBeenCalled();
    await usePlayer.getState().seekBook(170);
    expect(rx.remote.seek).toHaveBeenCalledWith(70);
    await usePlayer.getState().setRate(1.25);
    expect(rx.remote.setRate).toHaveBeenCalledWith(1.25);
    // The sleep timer's fade never reaches the TV's volume.
    await usePlayer.getState().setOutputVolume(0.3);
    expect(mockLocal.setVolume).not.toHaveBeenCalledWith(0.3);

    // The TV played on; the session ends: the place comes back, saved, paused.
    rx.status({
      playerState: 'playing',
      contentId: 'https://h/2/B/2.mp3?token=CAST',
      position: 90,
    });
    mockSaveProgress.mockClear();
    await currentRouter()!.endCast();
    await flush();
    expect(mockSaveProgress).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({ position: 190 }),
    );
    expect(mockLocal.load).toHaveBeenLastCalledWith(
      expect.any(Array),
      1,
      90,
      expect.anything(),
      expect.objectContaining({ path: 'B' }),
    );
    expect(usePlayer.getState().snapshot.state).toBe('paused');
    expect(mockLocal.play).toHaveBeenCalledTimes(1); // only the original start
  });

  it('a resume whose token was ended ends playing at the asked place, never "Playback stopped"', async () => {
    // Device log 20:38:48 and 20:40:01 (Pixel 6a, Default Media Receiver): the book finished on
    // the TV and the store let it go; another device left it at file 2, 0:20; the cached cast
    // token was ended. Resume: the receiver takes the load (Android answers it then), is
    // refused both files, the queue goes again with a new token, and the receiver lands it
    // PAUSED. A play that reaches it before it has loaded the file is lost.
    await usePlayer.getState().stop();
    await flush();
    let onStatus: ((s: CastMediaStatus | null) => void) | null = null;
    const loads: CastQueueLoad[] = [];
    const answers: (() => void)[] = [];
    const rateAnswers: (() => void)[] = [];
    let landed = false;
    const remote: CastRemote = {
      load: jest.fn(
        (r: CastQueueLoad) =>
          new Promise<void>((resolve) => {
            loads.push(r);
            landed = false;
            answers.push(resolve);
          }),
      ),
      // Taken only once the receiver has loaded the file; its status comes a moment later.
      play: jest.fn(async () => {
        if (!landed) return;
        await Promise.resolve();
        status({ playerState: 'playing', contentId: url(1), position: 19.9 });
      }),
      pause: jest.fn(async () => {}),
      seek: jest.fn(async () => {}),
      // The speed's round trip: the store plays once it is answered.
      setRate: jest.fn(() => new Promise<void>((resolve) => rateAnswers.push(resolve))),
      stop: jest.fn(async () => {}),
      readStatus: jest.fn(async () => null),
      onStatus: (h) => {
        onStatus = h;
        return () => {};
      },
      onProgress: () => () => {},
    };
    let minted = 0;
    const cast = new CastPlaybackService(remote, async (tracks, b, opts) => {
      if (opts?.freshToken) minted++;
      const token = `CAST${minted}`;
      return {
        items: buildCastItems(
          tracks,
          b,
          {
            streamUrl: (lib: number, path: string) => `https://h/${lib}/${path}?token=${token}`,
            coverUrl: () => 'https://h/cover',
          },
          false,
        ),
      };
    });
    const url = (i: number) => loads.at(-1)!.items[i].url;
    const status = (s: Partial<CastMediaStatus>) =>
      onStatus?.({ playerState: 'playing', position: 0, rate: 1, ...s });
    await initializePlayback();
    await currentRouter()!.beginCast(cast);

    mockLoadInitial.mockResolvedValueOnce({
      kind: 'progress',
      progress: { position: 120, finished: false, version: 0, playback_speed: 1 },
    });
    const resume = usePlayer.getState().playBook('c1', 2, book, chapters);
    await flush();
    expect(loads[0]).toMatchObject({ startIndex: 1, startTime: 20 });
    const old = loads[0].items.map((i) => i.url);
    status({ playerState: 'idle', idleReason: null, contentId: old[1] });
    answers.shift()!();
    await flush();
    status({ playerState: 'idle', idleReason: 'error', contentId: old[1] });
    await flush();
    expect(minted).toBe(1);
    status({ playerState: 'idle', idleReason: 'error', contentId: old[1] });
    // The reload goes out paused; the store's play comes as the receiver takes it.
    expect(loads[1]).toMatchObject({ startIndex: 1, startTime: 20, autoplay: false });
    status({ playerState: 'idle', idleReason: null, contentId: url(1) });
    for (const answer of rateAnswers.splice(0)) answer();
    await flush();
    status({ playerState: 'buffering', contentId: url(1) });
    answers.shift()!();
    await flush();
    await resume;
    // The reload lands paused, as sent.
    landed = true;
    status({ playerState: 'paused', contentId: url(1), position: 19.9 });
    await flush();
    jest.advanceTimersByTime(4_000);
    expect(usePlayer.getState().snapshot).toMatchObject({ state: 'playing', trackIndex: 1 });
    expect(minted).toBe(1);
  });
});
