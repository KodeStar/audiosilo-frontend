import {
  INITIAL_SNAPSHOT,
  type PlaybackService,
  type PlaybackSnapshot,
  type PlaybackTrack,
} from '@/playback/types';

import { CastBlockedError } from './cast-prepare';
import type { CastPlaybackService } from './cast-service';
import {
  currentRouter,
  forgetRouter,
  routed,
  RoutedPlaybackService,
  whenRouter,
} from './routed-service';

const BOOK = { connectionId: 'srv.3', libraryId: 2, path: 'A/B' };
const TRACKS: PlaybackTrack[] = [
  { id: '2:A/B/1.mp3', url: 'file:///1.mp3', title: 'B', duration: 600 },
  { id: '2:A/B/2.mp3', url: 'file:///2.mp3', title: 'B', duration: 600 },
];

type Fake = PlaybackService & {
  calls: string[];
  emit(patch: Partial<PlaybackSnapshot>): void;
  move?: (t: number, p: number) => void;
};

/** An engine that records what it is asked and emits what a test tells it to. */
function fakeEngine(name: string, extra: Partial<PlaybackService> = {}): Fake {
  let snap: PlaybackSnapshot = { ...INITIAL_SNAPSHOT };
  const listeners = new Set<(s: PlaybackSnapshot) => void>();
  const calls: string[] = [];
  const emit = (patch: Partial<PlaybackSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const l of listeners) l(snap);
  };
  const engine: Fake = {
    calls,
    emit,
    setup: async () => {},
    configure: async () => {
      calls.push(`${name}.configure`);
    },
    load: jest.fn(async (_t, index, position) => {
      calls.push(`${name}.load(${index},${position})`);
      emit({ state: 'ready', trackIndex: index, position });
    }),
    play: jest.fn(async () => {
      calls.push(`${name}.play`);
      emit({ state: 'playing' });
    }),
    pause: jest.fn(async () => {
      calls.push(`${name}.pause`);
      emit({ state: 'paused' });
    }),
    seekTo: jest.fn(async (p) => {
      calls.push(`${name}.seekTo(${p})`);
    }),
    skipToTrack: jest.fn(async (i) => {
      calls.push(`${name}.skipToTrack(${i})`);
    }),
    setRate: jest.fn(async (r) => {
      calls.push(`${name}.setRate(${r})`);
      emit({ rate: r });
    }),
    setVolume: jest.fn(async () => {
      calls.push(`${name}.setVolume`);
    }),
    reset: jest.fn(async () => {
      calls.push(`${name}.reset`);
      emit({ ...INITIAL_SNAPSHOT, rate: snap.rate });
    }),
    onRemoteMove(h) {
      engine.move = h ?? undefined;
    },
    onRateChange() {},
    getSnapshot: () => snap,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    ...extra,
  };
  return engine;
}

function fakeCast() {
  const engine = fakeEngine('cast') as Fake & {
    detach: jest.Mock;
    refresh: jest.Mock;
  };
  engine.detach = jest.fn();
  engine.refresh = jest.fn(async () => {});
  return engine;
}

function setup(localExtra: Partial<PlaybackService> = {}) {
  const local = fakeEngine('local', localExtra);
  const router = new RoutedPlaybackService(local);
  const seen: PlaybackSnapshot[] = [];
  router.subscribe((s) => seen.push(s));
  const moves: [number, number][] = [];
  router.onRemoteMove((t, p) => moves.push([t, p]));
  return { local, router, seen, moves };
}

/** A book loaded on the phone and playing at (1, 120) at 1.5x. */
async function playingLocally(t: ReturnType<typeof setup>) {
  await t.router.load(TRACKS, 1, 100, [], BOOK);
  await t.router.setRate(1.5);
  await t.router.play();
  t.local.emit({ position: 120 });
}

describe('RoutedPlaybackService', () => {
  afterEach(() => forgetRouter());

  it('is the phone engine, transparently, while nothing casts', async () => {
    const t = setup();
    await playingLocally(t);
    expect(t.local.calls).toEqual(['local.load(1,100)', 'local.setRate(1.5)', 'local.play']);
    expect(t.seen.at(-1)).toMatchObject({ state: 'playing', trackIndex: 1, position: 120 });
    t.local.move?.(1, 30);
    expect(t.moves).toEqual([[1, 30]]);
  });

  it('hands a playing book to the receiver: a paused save here, then a load there that plays on', async () => {
    const t = setup();
    await playingLocally(t);
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    // The store sees exactly one pause at the place (and saves it), nothing of the reset.
    const after = t.seen.slice(t.seen.findIndex((s) => s.state === 'paused'));
    expect(after[0]).toMatchObject({ state: 'paused', trackIndex: 1, position: 120, rate: 1.5 });
    expect(t.seen.some((s) => s.state === 'idle')).toBe(false);
    expect(t.local.calls.slice(-2)).toEqual(['local.pause', 'local.reset']);
    expect(cast.calls).toEqual(['cast.load(1,120)', 'cast.setRate(1.5)', 'cast.play']);
    expect(t.router.castRoute()).not.toBeNull();
    expect(t.seen.at(-1)).toMatchObject({ state: 'playing', trackIndex: 1, position: 120 });
  });

  it('hands a paused book over paused', async () => {
    const t = setup();
    await playingLocally(t);
    await t.router.pause();
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    expect(cast.calls).toEqual(['cast.load(1,120)', 'cast.setRate(1.5)']);
  });

  it('drives the receiver while casting, and forwards only its snapshots and moves', async () => {
    const t = setup();
    await playingLocally(t);
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    await t.router.pause();
    await t.router.seekTo(10);
    await t.router.skipToTrack(0, 5);
    await t.router.setVolume(0.2);
    expect(cast.calls.slice(-4)).toEqual([
      'cast.pause',
      'cast.seekTo(10)',
      'cast.skipToTrack(0)',
      'cast.setVolume',
    ]);
    const n = t.seen.length;
    t.local.emit({ state: 'playing', position: 999 }); // a stray phone event
    expect(t.seen).toHaveLength(n);
    cast.emit({ position: 11 });
    expect(t.seen.at(-1)?.position).toBe(11);
    cast.move?.(0, 40);
    expect(t.moves).toEqual([[0, 40]]);
  });

  it('loads a new book on the receiver while casting', async () => {
    const t = setup();
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    expect(t.router.castRoute()).not.toBeNull(); // nothing loaded: the route switches at once
    await t.router.load(TRACKS, 0, 50, [], BOOK);
    expect(cast.calls).toEqual(['cast.load(0,50)']);
    expect(t.local.calls).toEqual([]);
  });

  it('keeps a book that cannot be cast on the phone, paused at its place, and says why', async () => {
    const t = setup();
    await playingLocally(t);
    const cast = fakeCast();
    (cast.load as jest.Mock).mockRejectedValueOnce(new CastBlockedError('codec'));
    const failed = jest.fn();
    t.router.onCastFailed = failed;
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    expect(failed).toHaveBeenCalledWith(expect.any(CastBlockedError));
    expect(t.router.castRoute()).toBeNull();
    expect(t.local.calls.slice(-2)).toEqual(['local.load(1,120)', 'local.setRate(1.5)']);
    expect(cast.detach).toHaveBeenCalled();
    await t.router.play();
    expect(t.local.calls.at(-1)).toBe('local.play');
  });

  it('plays a new book here when it cannot be cast mid-session', async () => {
    const t = setup();
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    (cast.load as jest.Mock).mockRejectedValueOnce(new CastBlockedError('local-address'));
    const failed = jest.fn();
    t.router.onCastFailed = failed;
    await t.router.load(TRACKS, 1, 7, [], BOOK);
    expect(t.local.calls).toEqual(['local.load(1,7)']);
    expect(failed).toHaveBeenCalled();
    expect(t.router.castRoute()).toBeNull();
  });

  it('hands the book back when the session ends: paused, at the receiver place, never playing', async () => {
    const t = setup();
    await playingLocally(t);
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    cast.emit({ state: 'playing', trackIndex: 0, position: 444 });
    const before = t.local.calls.length;
    await t.router.endCast();
    expect(t.router.castRoute()).toBeNull();
    expect(cast.detach).toHaveBeenCalled();
    const paused = t.seen.filter((s) => s.state === 'paused').at(-1);
    expect(paused).toMatchObject({ trackIndex: 0, position: 444 });
    expect(t.local.calls.slice(-2)).toEqual(['local.load(0,444)', 'local.setRate(1.5)']);
    expect(t.local.calls.slice(before)).not.toContain('local.play');
    // the phone is the route again
    await t.router.play();
    expect(t.local.calls.at(-1)).toBe('local.play');
  });

  it('restores the handed-over place when the session ends mid-handover', async () => {
    const t = setup();
    await playingLocally(t);
    const cast = fakeCast();
    let finishLoad: () => void = () => {};
    (cast.load as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((r) => (finishLoad = r)),
    );
    const begin = t.router.beginCast(cast as unknown as CastPlaybackService);
    await Promise.resolve();
    await Promise.resolve();
    await t.router.endCast();
    finishLoad();
    await begin;
    expect(t.router.castRoute()).toBeNull();
    expect(t.local.calls.filter((c) => c.startsWith('local.load')).at(-1)).toBe(
      'local.load(1,120)',
    );
    expect(cast.calls).not.toContain('cast.play');
  });

  it('does not hand back a book that ended or was stopped on the receiver', async () => {
    const t = setup();
    await playingLocally(t);
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    cast.emit({ state: 'ended' });
    const loads = t.local.calls.filter((c) => c.startsWith('local.load')).length;
    await t.router.endCast();
    expect(t.local.calls.filter((c) => c.startsWith('local.load'))).toHaveLength(loads);
  });

  it('only remembers a finished download while casting (the receiver streams on)', async () => {
    const swapTo = jest.fn(async () => true);
    const t = setup({ swapTo });
    await playingLocally(t);
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    const localTracks = TRACKS.map((tr) => ({ ...tr, url: `file:///dl/${tr.id}` }));
    expect(await t.router.swapTo!(localTracks, 0, 1, [], BOOK)).toBe(true);
    expect(swapTo).not.toHaveBeenCalled();
    cast.emit({ state: 'paused', trackIndex: 1, position: 10 });
    await t.router.endCast();
    expect((t.local.load as jest.Mock).mock.calls.at(-1)?.[0]).toBe(localTracks);
  });

  it('has no swapTo when the phone engine has none (the store then loads)', () => {
    expect(setup().router.swapTo).toBeUndefined();
  });

  it('saves the cast place on a checkpoint through the store remote-move path', async () => {
    const t = setup();
    await playingLocally(t);
    t.router.checkpoint(); // not casting: nothing
    expect(t.moves).toEqual([]);
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    cast.emit({ state: 'playing', trackIndex: 1, position: 500 });
    t.router.checkpoint();
    expect(t.moves).toEqual([[1, 500]]);
  });

  it('keeps OS route picking and configuration on the phone engine', async () => {
    const showRoutePicker = jest.fn(async () => true);
    const t = setup({ canShowRoutePicker: () => true, showRoutePicker });
    expect(t.router.canShowRoutePicker()).toBe(true);
    await t.router.showRoutePicker();
    expect(showRoutePicker).toHaveBeenCalled();
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    await t.router.configure({
      autoRewindMax: 0,
      jumpBackward: 15,
      jumpForward: 30,
      smartSpeed: false,
      voiceBoost: false,
    });
    expect(t.local.calls).toContain('local.configure');
  });
});

describe('the one router', () => {
  afterEach(() => forgetRouter());

  it('is handed to whoever waits for it, once the store creates its engine', () => {
    const got = jest.fn();
    whenRouter(got);
    expect(currentRouter()).toBeNull();
    const r = routed(fakeEngine('local'));
    expect(got).toHaveBeenCalledWith(r);
    expect(currentRouter()).toBe(r);
    const later = jest.fn();
    whenRouter(later);
    expect(later).toHaveBeenCalledWith(r);
  });
});
