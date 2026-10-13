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
