import {
  type BookRef,
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
  LOCAL_LOAD_WAIT_MS,
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
  landed?: () => void;
  playAsked?: () => void;
  pauseAsked?: () => void;
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
    onLanded(h) {
      engine.landed = h ?? undefined;
    },
    onPlayAsked(h) {
      engine.playAsked = h ?? undefined;
    },
    onPauseAsked(h) {
      engine.pauseAsked = h ?? undefined;
    },
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
    loadedBook: () => BookRef | null;
    loadedQueue: () => { tracks: PlaybackTrack[]; book: BookRef } | null;
  };
  engine.detach = jest.fn();
  engine.refresh = jest.fn(async () => {});
  // The queue of its last load (the receiver's), none after a reset since.
  engine.loadedQueue = () => {
    const load = engine.load as jest.Mock;
    const reset = engine.reset as jest.Mock;
    const last = load.mock.invocationCallOrder.length - 1;
    if (last < 0) return null;
    const lastReset = Math.max(0, ...reset.mock.invocationCallOrder);
    if (load.mock.invocationCallOrder[last] < lastReset) return null;
    const args = load.mock.calls[last] as unknown[];
    return { tracks: args[0] as PlaybackTrack[], book: args[4] as BookRef };
  };
  engine.loadedBook = () => engine.loadedQueue()?.book ?? null;
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

  it('finding 8: reset cancels a Cast handover awaiting its load', async () => {
    const t = setup();
    await playingLocally(t);
    const cast = fakeCast();
    let finish!: () => void;
    (cast.load as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const handover = t.router.beginCast(cast as unknown as CastPlaybackService);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(finish).toBeDefined();
    await t.router.reset();
    expect(cast.reset).toHaveBeenCalled();
    finish();
    await handover;
    expect(cast.play).not.toHaveBeenCalled();
    expect(t.router.getSnapshot().state).toBe('idle');
    await t.router.endCast();
    expect(t.local.load).toHaveBeenCalledTimes(1);
  });

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

  it('passes on a place the phone engine landed at late, never while casting', async () => {
    const t = setup();
    const landed = jest.fn();
    t.router.onLanded(landed);
    await playingLocally(t);
    t.local.landed?.();
    expect(landed).toHaveBeenCalledTimes(1);
    await t.router.beginCast(fakeCast() as unknown as CastPlaybackService);
    t.local.landed?.();
    expect(landed).toHaveBeenCalledTimes(1);
  });

  it('passes on a play the phone engine was asked for, never while casting', async () => {
    const t = setup();
    const asked = jest.fn();
    t.router.onPlayAsked(asked);
    await playingLocally(t);
    t.local.playAsked?.();
    expect(asked).toHaveBeenCalledTimes(1);
    await t.router.beginCast(fakeCast() as unknown as CastPlaybackService);
    t.local.playAsked?.();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('passes on the phone engine stopping wanting to play, never while casting', async () => {
    const t = setup();
    const stopped = jest.fn();
    t.router.onPauseAsked(stopped);
    await playingLocally(t);
    t.local.pauseAsked?.();
    expect(stopped).toHaveBeenCalledTimes(1);
    await t.router.beginCast(fakeCast() as unknown as CastPlaybackService);
    t.local.pauseAsked?.();
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("names the phone engine's reported book, and the receiver's own while casting", async () => {
    const book = { connectionId: 'c1', libraryId: 2, path: 'A' };
    const t = setup({ reportedBook: () => book });
    await playingLocally(t);
    expect(t.router.reportedBook()).toEqual(book);
    // On the receiver: the book handed over, never the phone engine's last word.
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    expect(t.router.reportedBook()).toEqual(BOOK);
    // None while another book is on its way there: the receiver still reports the old one.
    const next = { connectionId: 'srv.3', libraryId: 2, path: 'A/C' };
    let land!: () => void;
    (cast.load as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    const loading = t.router.load(TRACKS, 0, 0, [], next);
    expect(t.router.reportedBook()).toBeNull();
    land();
    await loading;
    expect(t.router.reportedBook()).toEqual(next);
    // Nor once nothing is loaded.
    await t.router.reset();
    expect(t.router.reportedBook()).toBeNull();
    await t.router.endCast();
    expect(t.router.reportedBook()).toEqual(book);
  });

  // FE-ANDROID-5: the phone's engine held another book than the loaded one (the car's, not
  // adopted), so the router's snapshot was that book's place and play state: the receiver
  // played the loaded book from the other book's place.
  it("hands the loaded book over at the store's place while the phone holds another book", async () => {
    const t = setup();
    await t.router.load(TRACKS, 1, 100, [], BOOK);
    // The car's book plays in the phone's engine: its reports are the router's snapshot.
    t.local.emit({ state: 'playing', trackIndex: 0, position: 80, rate: 1 });
    t.router.onLoadedPlace(() => ({
      state: 'paused',
      trackIndex: 1,
      position: 130,
      duration: 600,
      rate: 1.5,
    }));
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    expect(t.local.calls).toEqual(expect.arrayContaining(['local.pause', 'local.reset']));
    expect(cast.calls).toEqual(['cast.load(1,130)', 'cast.setRate(1.5)']);
    expect(t.seen.find((s) => s.state === 'paused')).toMatchObject({
      trackIndex: 1,
      position: 130,
      rate: 1.5,
    });
    expect(t.router.reportedBook()).toEqual(BOOK);
  });

  // The session ended while the phone was being paused for it: the hand-back read the
  // router's snapshot, still the car's book's, and loaded the store's book there.
  it("hands the store's place back when the session ends mid-switch, never the other book's", async () => {
    let paused: () => void = () => {};
    const t = setup({
      pause: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            paused = resolve;
          }),
      ),
    });
    await t.router.load(TRACKS, 1, 100, [], BOOK);
    t.local.emit({ state: 'playing', trackIndex: 0, position: 80, rate: 1 });
    t.router.onLoadedPlace(() => ({
      state: 'paused',
      trackIndex: 1,
      position: 130,
      duration: 600,
      rate: 1.5,
    }));
    const cast = fakeCast();
    const began = t.router.beginCast(cast as unknown as CastPlaybackService);
    const ended = t.router.endCast();
    paused();
    await Promise.all([began, ended]);
    expect(cast.calls).toEqual([]);
    expect(t.local.calls.slice(-2)).toEqual(['local.load(1,130)', 'local.setRate(1.5)']);
    expect(t.seen.filter((s) => s.state === 'paused').at(-1)).toMatchObject({
      trackIndex: 1,
      position: 130,
    });
    expect(t.router.castRoute()).toBeNull();
  });

  // The store's book ended, so nothing goes to the receiver: the car's book must not play on
  // in the phone's engine with the receiver as the route.
  it("stops the phone's other book when the loaded book has no place to hand over", async () => {
    const t = setup();
    await t.router.load(TRACKS, 1, 100, [], BOOK);
    t.local.emit({ state: 'playing', trackIndex: 0, position: 80, rate: 1 });
    t.router.onLoadedPlace(() => ({
      state: 'ended',
      trackIndex: 1,
      position: 600,
      duration: 600,
      rate: 1,
    }));
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    expect(cast.calls).toEqual([]);
    expect(t.local.calls.at(-1)).toBe('local.reset');
    expect(t.router.castRoute()).not.toBeNull();
    // Without another book in the phone's engine, an ended book's engine is left as it is.
    const u = setup();
    await u.router.load(TRACKS, 1, 100, [], BOOK);
    u.local.emit({ state: 'ended' });
    await u.router.beginCast(fakeCast() as unknown as CastPlaybackService);
    expect(u.local.calls).not.toContain('local.reset');
  });

  it("hands over at the phone's own place when the store says nothing of another book", async () => {
    const t = setup();
    await playingLocally(t);
    t.router.onLoadedPlace(() => null);
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    expect(cast.calls).toEqual(['cast.load(1,120)', 'cast.setRate(1.5)', 'cast.play']);
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

  it('keeps the download remembered during a refused handover on the phone, not the stream', async () => {
    const t = setup();
    await playingLocally(t);
    const cast = fakeCast();
    const localTracks = TRACKS.map((tr) => ({ ...tr, url: `file:///dl/${tr.id}` }));
    // The book's download lands while the receiver is being asked (the store's hot-swap
    // sees a cast route and only remembers the phone's copy), then the receiver refuses.
    (cast.load as jest.Mock).mockImplementationOnce(async () => {
      t.router.rememberLoad({ tracks: localTracks, chapters: [], book: BOOK });
      throw new CastBlockedError('codec');
    });
    t.router.onCastFailed = jest.fn();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    expect(t.router.castRoute()).toBeNull();
    const reload = (t.local.load as jest.Mock).mock.calls.at(-1)!;
    expect(reload.slice(0, 3)).toEqual([localTracks, 1, 120]);
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

  it('plays the download remembered while a book could not be cast mid-session', async () => {
    const t = setup();
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    const localTracks = TRACKS.map((tr) => ({ ...tr, url: `file:///dl/${tr.id}` }));
    // The book's download lands while the receiver is asked, then the receiver refuses.
    (cast.load as jest.Mock).mockImplementationOnce(async () => {
      t.router.rememberLoad({ tracks: localTracks, chapters: [], book: BOOK });
      throw new CastBlockedError('local-address');
    });
    t.router.onCastFailed = jest.fn();
    await t.router.load(TRACKS, 1, 7, [], BOOK);
    expect(t.router.castRoute()).toBeNull();
    const reload = (t.local.load as jest.Mock).mock.calls.at(-1)!;
    expect(reload.slice(0, 3)).toEqual([localTracks, 1, 7]);
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

  // A re-pair while casting: the receiver streams on its cast token, and the book handed
  // back to the phone at the session's end streams with the connection's new one.
  it('hands back a book restreamed while casting at its new addresses, and tells the phone engine', async () => {
    const restream = jest.fn();
    const t = setup({ restream });
    await playingLocally(t);
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    const renewed = TRACKS.map((tr) => ({ ...tr, url: `${tr.url}?token=new` }));
    t.router.restream(renewed);
    expect(restream).toHaveBeenCalledWith(renewed);
    await t.router.endCast();
    expect(t.local.load).toHaveBeenLastCalledWith(
      renewed,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps the queue it hands over when a restream is of other files', async () => {
    const t = setup();
    await playingLocally(t);
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    t.router.restream([{ ...TRACKS[0], id: '2:other' }]);
    await t.router.endCast();
    expect(t.local.load).toHaveBeenLastCalledWith(
      TRACKS,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('tells the store of the load it makes on the phone as the session ends', async () => {
    const t = setup();
    const told: unknown[][] = [];
    t.router.onOwnLoad((...args) => told.push(args));
    await playingLocally(t);
    expect(told).toEqual([]); // the store's own load is the store's ask
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    expect(told).toEqual([]);
    cast.emit({ state: 'playing', trackIndex: 1, position: 500 });
    await t.router.endCast();
    expect(told).toEqual([[1, 500, expect.any(Promise)]]);
    expect(t.local.calls).toContain('local.load(1,500)');
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
    const swapTo = jest.fn(async () => 'swapped' as const);
    const t = setup({ swapTo });
    await playingLocally(t);
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    const localTracks = TRACKS.map((tr) => ({ ...tr, url: `file:///dl/${tr.id}` }));
    expect(await t.router.swapTo!(localTracks, 0, 1, [], BOOK)).toBe('swapped');
    expect(swapTo).not.toHaveBeenCalled();
    cast.emit({ state: 'paused', trackIndex: 1, position: 10 });
    await t.router.endCast();
    expect((t.local.load as jest.Mock).mock.calls.at(-1)?.[0]).toBe(localTracks);
  });

  it('refuses a download holding other files while the route is not the phone', async () => {
    const swapTo = jest.fn(async () => 'swapped' as const);
    const t = setup({ swapTo });
    await playingLocally(t);
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    // One more file, first: the receiver's index 1 would read as another file through it.
    const extra = { id: '2:A/B/0.mp3', url: 'file:///dl/0.mp3', title: 'B', duration: 600 };
    const otherFiles = [extra, ...TRACKS.map((tr) => ({ ...tr, url: `file:///dl/${tr.id}` }))];
    const onSwitch = jest.fn();
    expect(await t.router.swapTo!(otherFiles, 2, 1, [], BOOK, onSwitch)).toBe('refused');
    expect(swapTo).not.toHaveBeenCalled();
    expect(onSwitch).not.toHaveBeenCalled();
    cast.emit({ state: 'paused', trackIndex: 1, position: 10 });
    await t.router.endCast();
    // The hand-back loads what the receiver played, in its order.
    expect((t.local.load as jest.Mock).mock.calls.at(-1)?.[0]).toBe(TRACKS);
  });

  it('remembers no download after a reset while the route is not the phone', async () => {
    const swapTo = jest.fn(async () => 'swapped' as const);
    const t = setup({ swapTo });
    await playingLocally(t);
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    await t.router.reset();
    const localTracks = TRACKS.map((tr) => ({ ...tr, url: `file:///dl/${tr.id}` }));
    expect(await t.router.swapTo!(localTracks, 0, 1, [], BOOK)).toBe('refused');
    const loads = (t.local.load as jest.Mock).mock.calls.length;
    await t.router.endCast();
    // Nothing comes back to the phone: the stopped book was not remembered again.
    expect((t.local.load as jest.Mock).mock.calls).toHaveLength(loads);
  });

  it('has no swapTo when the phone engine has none (the store then loads)', () => {
    expect(setup().router.swapTo).toBeUndefined();
  });

  it('saves the cast place on a checkpoint through the store remote-move path', async () => {
    const t = setup();
    const told: unknown[][] = [];
    t.router.onRemoteMove((...args) => told.push(args));
    await playingLocally(t);
    t.router.checkpoint(); // not casting: nothing
    expect(told).toEqual([]);
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    cast.emit({ state: 'playing', trackIndex: 1, position: 500 });
    t.router.checkpoint();
    // Told as a checkpoint: the store keeps a faulted book's own place.
    expect(told).toEqual([[1, 500, true]]);
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

const OTHER = { connectionId: 'srv.3', libraryId: 2, path: 'C/D' };
const OTHER_TRACKS: PlaybackTrack[] = [
  { id: '2:C/D/1.mp3', url: 'file:///c1.mp3', title: 'D', duration: 900 },
];

/** A cast whose next `load` waits until the test lets it go. */
function heldCast() {
  const cast = fakeCast();
  const held: { finish: () => void; fail: (e: unknown) => void }[] = [];
  (cast.load as jest.Mock).mockImplementationOnce(
    (_t: unknown, index: number, position: number) =>
      new Promise<void>((resolve, reject) => {
        cast.calls.push(`cast.load(${index},${position})`);
        held.push({ finish: resolve, fail: reject });
      }),
  );
  return { cast, held };
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('RoutedPlaybackService: a book started while the route is changing', () => {
  afterEach(() => forgetRouter());

  it('a book started during a handover goes to the receiver; the handover stands back', async () => {
    const t = setup();
    await playingLocally(t);
    const { cast, held } = heldCast();
    const handover = t.router.beginCast(cast as unknown as CastPlaybackService);
    await settle();
    expect(held).toHaveLength(1); // the old book is on its way to the receiver
    // The listener starts another book meanwhile.
    const start = t.router.load(OTHER_TRACKS, 0, 30, [], OTHER);
    await settle();
    held[0].finish();
    await handover;
    await start;
    await t.router.play();
    // The new book went to the receiver and plays there; nothing plays on the phone.
    expect(cast.calls).toContain('cast.load(0,30)');
    expect(cast.calls.filter((c) => c === 'cast.play')).toHaveLength(1);
    expect(t.local.calls).not.toContain('local.load(0,30)');
    expect(cast.reset).not.toHaveBeenCalled(); // the receiver keeps the new book
    expect(t.router.isCasting()).toBe(true);
  });

  it('a load the receiver rejected because a newer one replaced it keeps the session', async () => {
    const t = setup();
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    const failed = jest.fn();
    t.router.onCastFailed = failed;
    let reject!: (e: unknown) => void;
    (cast.load as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, r) => {
          reject = r;
        }),
    );
    const first = t.router.load(TRACKS, 0, 0, [], BOOK);
    await settle();
    await t.router.load(OTHER_TRACKS, 0, 0, [], OTHER); // a second tap
    reject(new Error('REPLACED'));
    await first;
    expect(failed).not.toHaveBeenCalled();
    expect(t.router.castRoute()).toBe(cast);
    expect(t.local.calls.some((c) => c.startsWith('local.load'))).toBe(false);
  });

  it('a session that ends while a new book is on its way hands back that book at its own start', async () => {
    const t = setup();
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    await t.router.load(TRACKS, 1, 500, [], BOOK); // book A on the receiver, file 2 at 500
    cast.emit({ state: 'playing', trackIndex: 1, position: 500 });
    let reject!: (e: unknown) => void;
    (cast.load as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, r) => {
          reject = r;
        }),
    );
    const start = t.router.load(OTHER_TRACKS, 0, 10, [], OTHER); // book C, at 10
    await settle();
    // The TV goes off meanwhile; the phone's engine takes a moment to load C back.
    let loaded!: () => void;
    (t.local.load as jest.Mock).mockImplementationOnce(
      (_t: unknown, index: number, position: number) =>
        new Promise<void>((resolve) => {
          t.local.calls.push(`local.load(${index},${position})`);
          loaded = resolve;
        }),
    );
    const ended = t.router.endCast();
    reject(new Error('No session'));
    let settled = false;
    void start.catch(() => undefined).finally(() => (settled = true));
    await settle();
    expect(settled).toBe(false); // the start waits for the hand-back
    loaded();
    await ended;
    // The start fails (the phone never plays by itself when a cast ends)...
    await expect(start).rejects.toThrow('No session');
    // ...and C is back on the phone where it was started, paused, never at A's place.
    expect(t.local.calls).toContain('local.load(0,10)');
    expect(t.local.calls).not.toContain('local.load(1,500)');
    expect(t.local.calls).not.toContain('local.play');
    expect(t.seen.at(-1)).toMatchObject({ state: 'paused', trackIndex: 0, position: 10 });
  });

  it("the phone's copy of a book on its way, remembered meanwhile, is still that book", async () => {
    const t = setup();
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    await t.router.load(TRACKS, 1, 500, [], BOOK);
    cast.emit({ state: 'playing', trackIndex: 1, position: 500 });
    let reject!: (e: unknown) => void;
    (cast.load as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, r) => {
          reject = r;
        }),
    );
    const start = t.router.load(OTHER_TRACKS, 0, 10, [], OTHER);
    await settle();
    // C's download lands meanwhile: the store hands the route the phone's copy.
    t.router.rememberLoad({
      tracks: OTHER_TRACKS.map((x) => ({ ...x })),
      chapters: [],
      book: OTHER,
    });
    await t.router.endCast();
    reject(new Error('No session'));
    await expect(start).rejects.toThrow('No session');
    expect(t.local.calls).toContain('local.load(0,10)'); // its own start, not A's place
  });

  it('a book started during a handover unloads the old book from the phone', async () => {
    const t = setup();
    await playingLocally(t);
    let paused!: () => void;
    (t.local.pause as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          t.local.calls.push('local.pause');
          paused = resolve;
        }),
    );
    const cast = fakeCast();
    const handover = t.router.beginCast(cast as unknown as CastPlaybackService);
    await settle();
    const start = t.router.load(OTHER_TRACKS, 0, 30, [], OTHER); // before the pause landed
    paused();
    await handover;
    await start;
    expect(t.local.calls).toContain('local.reset');
    expect(cast.calls).toContain('cast.load(0,30)');
  });

  // FE-ANDROID-5: an adoption (the Android service's book) that landed while a handover was on
  // its way remembered its own book, and the receiver's reports were named as that book while
  // it played the one handed over.
  it('names the book the receiver took, never one an adoption remembered mid-handover', async () => {
    const t = setup();
    await playingLocally(t);
    const { cast, held } = heldCast();
    const handover = t.router.beginCast(cast as unknown as CastPlaybackService);
    await settle();
    expect(held).toHaveLength(1);
    t.router.rememberLoad({ tracks: OTHER_TRACKS, chapters: [], book: OTHER });
    held[0].finish();
    await handover;
    expect(t.router.isCasting()).toBe(true);
    expect(t.router.reportedBook()).toEqual(BOOK);
  });

  // FE-ANDROID-5: the session ended once the receiver played the book handed over, while the
  // store remembered the book an adoption took mid-handover. The phone got that book at the
  // receiver's place, told the store as its own load and reported unnamed, so the store saved
  // the receiver's place as its book's.
  it('hands back the book the receiver holds, named, never one an adoption remembered', async () => {
    const t = setup();
    const told: unknown[][] = [];
    t.router.onOwnLoad((...args) => told.push(args));
    await playingLocally(t);
    const { cast, held } = heldCast();
    const handover = t.router.beginCast(cast as unknown as CastPlaybackService);
    await settle();
    t.router.rememberLoad({ tracks: OTHER_TRACKS, chapters: [], book: OTHER });
    held[0].finish();
    await handover;
    cast.emit({ state: 'playing', trackIndex: 1, position: 400 });
    const named: (BookRef | null)[] = [];
    t.router.subscribe(() => named.push(t.router.reportedBook()));
    await t.router.endCast();
    expect(t.local.load).toHaveBeenLastCalledWith(TRACKS, 1, 400, undefined, BOOK);
    expect(named[0]).toEqual(BOOK);
    expect(t.seen.at(-1)).toMatchObject({ state: 'paused', trackIndex: 1, position: 400 });
    expect(told).toEqual([]);
  });

  it('hands back the book being handed over when the session ends mid-handover', async () => {
    const t = setup();
    await playingLocally(t);
    const { cast, held } = heldCast();
    const handover = t.router.beginCast(cast as unknown as CastPlaybackService);
    await settle();
    t.router.rememberLoad({ tracks: OTHER_TRACKS, chapters: [], book: OTHER });
    await t.router.endCast();
    held[0].finish();
    await handover;
    expect(t.local.load).toHaveBeenLastCalledWith(TRACKS, 1, 120, [], BOOK);
  });

  /** A phone engine whose next load waits for `land()`, which reports it there. */
  function heldLocalLoad(t: ReturnType<typeof setup>) {
    const hold: { land: () => void } = { land: () => {} };
    (t.local.load as jest.Mock).mockImplementationOnce(
      (_t: unknown, index: number, position: number) =>
        new Promise<void>((resolve) => {
          t.local.calls.push(`local.load(${index},${position})`);
          hold.land = () => {
            t.local.emit({ state: 'ready', trackIndex: index, position });
            resolve();
          };
        }),
    );
    return hold;
  }

  // FE-ANDROID-5: a session that began while the store's own load was on its way into the
  // phone's engine handed the new book over at the place (and play state) of the book that
  // load replaced.
  it('hands over a book still loading into the phone from where its load lands', async () => {
    const t = setup();
    await playingLocally(t); // BOOK plays at (1, 120)
    const hold = heldLocalLoad(t);
    const start = t.router.load(OTHER_TRACKS, 0, 30, [], OTHER);
    await settle();
    const cast = fakeCast();
    const handover = t.router.beginCast(cast as unknown as CastPlaybackService);
    await settle();
    expect(cast.calls).toEqual([]); // waits for the load
    hold.land();
    await start;
    await handover;
    expect(cast.calls).toContain('cast.load(0,30)');
    expect(cast.calls).not.toContain('cast.load(1,120)');
    expect(t.router.reportedBook()).toEqual(OTHER);
  });

  it('makes no route of a session that ended while it waited for the phone to load', async () => {
    const t = setup();
    await playingLocally(t);
    const hold = heldLocalLoad(t);
    const start = t.router.load(OTHER_TRACKS, 0, 30, [], OTHER);
    await settle();
    const cast = fakeCast();
    const handover = t.router.beginCast(cast as unknown as CastPlaybackService);
    await settle();
    await t.router.endCast();
    hold.land();
    await start;
    await handover;
    expect(t.router.isCasting()).toBe(false);
    expect(cast.calls).toEqual([]);
    expect(t.local.calls).not.toContain('local.reset');
  });

  describe('a load into the phone that never lands', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    // FE-ANDROID-5: the session waited for the store's load for as long as it took, so one
    // that never landed kept the session from ever becoming the route.
    it('hands the book over from where its load was asked to start, after the bound', async () => {
      const t = setup();
      await playingLocally(t);
      heldLocalLoad(t); // never lands
      void t.router.load(OTHER_TRACKS, 0, 30, [], OTHER);
      await settle();
      const cast = fakeCast();
      const handover = t.router.beginCast(cast as unknown as CastPlaybackService);
      await settle();
      jest.advanceTimersByTime(LOCAL_LOAD_WAIT_MS - 1);
      await settle();
      expect(cast.calls).toEqual([]);
      jest.advanceTimersByTime(1);
      await handover;
      expect(t.router.isCasting()).toBe(true);
      expect(cast.calls).toContain('cast.load(0,30)');
      expect(cast.calls).not.toContain('cast.play');
      expect(jest.getTimerCount()).toBe(0);
    });

    it('leaves no timer once the load lands or the session ends', async () => {
      const t = setup();
      await playingLocally(t);
      const hold = heldLocalLoad(t);
      const start = t.router.load(OTHER_TRACKS, 0, 30, [], OTHER);
      await settle();
      const cast = fakeCast();
      const handover = t.router.beginCast(cast as unknown as CastPlaybackService);
      await settle();
      expect(jest.getTimerCount()).toBe(1);
      hold.land();
      await start;
      await handover;
      expect(jest.getTimerCount()).toBe(0);

      await t.router.endCast();
      heldLocalLoad(t); // never lands
      void t.router.load(TRACKS, 1, 10, [], BOOK);
      await settle();
      const next = fakeCast();
      const waiting = t.router.beginCast(next as unknown as CastPlaybackService);
      await settle();
      expect(jest.getTimerCount()).toBe(1);
      await t.router.endCast();
      await waiting;
      expect(jest.getTimerCount()).toBe(0);
      expect(t.router.isCasting()).toBe(false);
      expect(next.calls).toEqual([]);
    });

    it('lets a newer session replace one still waiting for the load', async () => {
      const t = setup();
      await playingLocally(t);
      const hold = heldLocalLoad(t);
      const start = t.router.load(OTHER_TRACKS, 0, 30, [], OTHER);
      await settle();
      const first = fakeCast();
      const second = fakeCast();
      const one = t.router.beginCast(first as unknown as CastPlaybackService);
      await settle();
      const two = t.router.beginCast(second as unknown as CastPlaybackService);
      await settle();
      await one;
      hold.land();
      await start;
      await two;
      expect(t.router.castRoute()).toBe(second);
      expect(first.calls).toEqual([]);
      expect(second.calls).toContain('cast.load(0,30)');
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it("hands over a book the store took over without loading it (the Android service's)", async () => {
    // The native bridge's adoptPlace seeds its snapshot (here: as an emit).
    const holder: { local?: Fake } = {};
    const t = setup({ adoptPlace: (snap) => holder.local?.emit(snap) });
    holder.local = t.local;
    // The store adopted the service's book: its place and its queue, never a load.
    t.router.adoptPlace({ ...INITIAL_SNAPSHOT, state: 'playing', trackIndex: 1, position: 80 });
    t.router.rememberLoad({ tracks: TRACKS, chapters: [], book: BOOK });
    const cast = fakeCast();
    await t.router.beginCast(cast as unknown as CastPlaybackService);
    // The phone stops, and the receiver gets the book at that place and plays it.
    expect(t.local.calls).toEqual(expect.arrayContaining(['local.pause', 'local.reset']));
    expect(cast.calls).toEqual(expect.arrayContaining(['cast.load(1,80)', 'cast.play']));
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
