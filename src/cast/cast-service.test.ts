import type { PlaybackSnapshot, PlaybackTrack } from '@/playback/types';

import { buildCastItems } from './cast-media';
import type { PrepareCast } from './cast-prepare';
import { CastPlaybackService, castState } from './cast-service';
import type { CastMediaStatus, CastQueueLoad, CastRemote } from './types';

const BOOK = { connectionId: 'srv.3', libraryId: 2, path: 'A/B' };

const TRACKS: PlaybackTrack[] = [0, 1, 2].map((i) => ({
  id: `2:A/B/0${i}.mp3`,
  url: `local-${i}`,
  title: 'Book',
  duration: 600,
}));

const urls = {
  streamUrl: (lib: number, path: string, _d?: boolean, o?: { transcode?: boolean }) =>
    `https://h/stream?path=${path}${o?.transcode ? '&transcode=1' : ''}&token=CAST`,
  coverUrl: () => 'https://h/cover?token=CAST',
};

function fakeRemote() {
  let statusHandler: ((s: CastMediaStatus | null) => void) | null = null;
  let progressHandler: ((p: number) => void) | null = null;
  const loads: CastQueueLoad[] = [];
  const remote: CastRemote & { loads: CastQueueLoad[] } = {
    loads,
    load: jest.fn(async (req: CastQueueLoad) => {
      loads.push(req);
    }),
    play: jest.fn(async () => {}),
    pause: jest.fn(async () => {}),
    seek: jest.fn(async () => {}),
    setRate: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    readStatus: jest.fn(async () => null),
    onStatus: (h) => {
      statusHandler = h;
      return () => {
        statusHandler = null;
      };
    },
    onProgress: (h) => {
      progressHandler = h;
      return () => {
        progressHandler = null;
      };
    },
  };
  return {
    remote,
    status: (s: Partial<CastMediaStatus> | null) =>
      statusHandler?.(s ? { playerState: 'playing', position: 0, rate: 1, ...s } : null),
    progress: (p: number) => progressHandler?.(p),
  };
}

const prepareWith =
  (transcode = false): PrepareCast =>
  async (tracks, book) => ({ items: buildCastItems(tracks, book, urls, transcode) });

function setup(opts: { transcode?: boolean } = {}) {
  const fake = fakeRemote();
  let clock = 1_000_000;
  const svc = new CastPlaybackService(fake.remote, prepareWith(opts.transcode), () => clock);
  const snaps: PlaybackSnapshot[] = [];
  svc.subscribe((s) => snaps.push(s));
  const moves: [number, number][] = [];
  svc.onRemoteMove((t, p) => moves.push([t, p]));
  const rates: number[] = [];
  svc.onRateChange((r) => rates.push(r));
  return {
    ...fake,
    svc,
    snaps,
    moves,
    rates,
    tick: (ms: number) => {
      clock += ms;
    },
    url: (i: number) => fake.remote.loads.at(-1)!.items[i].url,
  };
}

describe('castState', () => {
  const ctx = { prev: 'paused' as const, lastTrack: false, loading: false };
  const s = (
    playerState: CastMediaStatus['playerState'],
    idleReason?: CastMediaStatus['idleReason'],
  ) => ({ playerState, idleReason, position: 0, rate: 1 }) as CastMediaStatus;

  it('maps the receiver onto the store', () => {
    expect(castState(s('playing'), ctx)).toBe('playing');
    expect(castState(s('paused'), ctx)).toBe('paused');
    expect(castState(s('loading'), ctx)).toBe('loading');
    expect(castState(s('buffering'), ctx)).toBe('loading');
    // a buffer while playing is the receiver's own business: no stall watchdog for it
    expect(castState(s('buffering'), { ...ctx, prev: 'playing' })).toBe('playing');
  });

  it('reads idle by its reason', () => {
    expect(castState(s('idle', 'finished'), { ...ctx, lastTrack: true })).toBe('ended');
    expect(castState(s('idle', 'finished'), ctx)).toBe('loading'); // on to the next file
    expect(castState(s('idle', 'error'), ctx)).toBe('error');
    expect(castState(s('idle', 'cancelled'), ctx)).toBe('paused');
    expect(castState(s('idle', 'interrupted'), ctx)).toBe('paused');
    expect(castState(s('idle'), { ...ctx, loading: true })).toBe('loading');
    expect(castState(s('idle'), ctx)).toBe('idle');
  });
});

describe('CastPlaybackService', () => {
  it('loads the whole book as a queue at the store place, paused, and reports ready', async () => {
    const t = setup();
    await t.svc.setRate(1.5);
    await t.svc.load(TRACKS, 1, 125, [], BOOK);
    const req = t.remote.loads[0];
    expect(req.items).toHaveLength(3);
    expect(req.startIndex).toBe(1);
    expect(req.startTime).toBe(125);
    expect(req.rate).toBe(1.5);
    expect(req.autoplay).toBe(false); // the store plays it
    expect(req.book).toEqual(BOOK);
    expect(req.items.every((i) => i.url.includes('token=CAST'))).toBe(true);
    expect(t.svc.getSnapshot()).toMatchObject({ state: 'ready', trackIndex: 1, position: 125 });
  });

  it('needs the book (the receiver queue carries it)', async () => {
    const t = setup();
    await expect(t.svc.load(TRACKS, 0, 0)).rejects.toThrow();
  });

  it('maps the receiver item and position back to the track and place', async () => {
    const t = setup();
    await t.svc.load(TRACKS, 0, 0, [], BOOK);
    t.status({ playerState: 'playing', contentId: t.url(2), position: 33 });
    expect(t.svc.getSnapshot()).toMatchObject({
      state: 'playing',
      trackIndex: 2,
      position: 33,
      duration: 600,
    });
    t.tick(1000);
    t.progress(34);
    expect(t.svc.getSnapshot().position).toBe(34);
  });

  it('reports a move nobody here asked for (the TV remote) after the snapshot holds it', async () => {
    const t = setup();
    await t.svc.load(TRACKS, 0, 100, [], BOOK);
    t.tick(10_000); // the load's own move has landed
    t.status({ playerState: 'playing', contentId: t.url(0), position: 100 });
    t.tick(1_000);
    let seenAtMove: PlaybackSnapshot | null = null;
    t.svc.onRemoteMove(() => {
      seenAtMove = t.svc.getSnapshot();
    });
    t.status({ playerState: 'playing', contentId: t.url(0), position: 20 }); // scrubbed back
    expect(seenAtMove).toMatchObject({ trackIndex: 0, position: 20 });
  });

  it('does not report its own seeks, natural play or running on into the next file', async () => {
    const t = setup();
    await t.svc.load(TRACKS, 0, 100, [], BOOK);
    t.tick(10_000);
    t.status({ playerState: 'playing', contentId: t.url(0), position: 100 });
    t.tick(2_000);
    t.status({ playerState: 'playing', contentId: t.url(0), position: 102 });
    await t.svc.seekTo(400); // ours
    expect(t.remote.seek).toHaveBeenCalledWith(400);
    t.tick(500);
    t.status({ playerState: 'playing', contentId: t.url(0), position: 400 });
    t.tick(1_000);
    t.status({ playerState: 'playing', contentId: t.url(1), position: 0.5 }); // next file
    expect(t.moves).toEqual([]);
  });

  it('drops a progress tick that looks like a move until a status names the file', async () => {
    const t = setup();
    await t.svc.load(TRACKS, 0, 598, [], BOOK);
    t.tick(10_000);
    t.status({ playerState: 'playing', contentId: t.url(0), position: 598 });
    t.tick(3_000);
    t.progress(1); // the next file's first second, before its status
    expect(t.svc.getSnapshot()).toMatchObject({ trackIndex: 0, position: 598 });
    expect(t.remote.readStatus).toHaveBeenCalled();
    expect(t.moves).toEqual([]);
  });

  it('jumps to another file by reloading the queue from there (keeping play state)', async () => {
    const t = setup();
    await t.svc.load(TRACKS, 0, 0, [], BOOK);
    t.status({ playerState: 'playing', contentId: t.url(0), position: 5 });
    await t.svc.skipToTrack(2, 30);
    const req = t.remote.loads.at(-1)!;
    expect(req).toMatchObject({ startIndex: 2, startTime: 30, autoplay: true });
    expect(t.svc.getSnapshot()).toMatchObject({ trackIndex: 2, position: 30 });
  });

  it('seeks a transcoded file by asking for the stream from there, and adds that offset back', async () => {
    const t = setup({ transcode: true });
    await t.svc.load(TRACKS, 1, 200, [], BOOK);
    let req = t.remote.loads[0];
    expect(req.startTime).toBe(0);
    expect(req.items[1].url).toContain('t=200');
    t.status({ playerState: 'playing', contentId: req.items[1].url, position: 10 });
    expect(t.svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 210 });
    await t.svc.seekTo(50);
    expect(t.remote.seek).not.toHaveBeenCalled();
    req = t.remote.loads.at(-1)!;
    expect(req.items[1].url).toContain('t=50');
    t.status({ playerState: 'playing', contentId: req.items[1].url, position: 1 });
    expect(t.svc.getSnapshot().position).toBe(51);
  });

  it('ends the book only on the last file, at its end', async () => {
    const t = setup();
    await t.svc.load(TRACKS, 2, 590, [], BOOK);
    t.status({ playerState: 'playing', contentId: t.url(2), position: 595 });
    t.status({ playerState: 'idle', idleReason: 'finished', contentId: t.url(2), position: 0 });
    expect(t.svc.getSnapshot()).toMatchObject({ state: 'ended', trackIndex: 2, position: 600 });
  });

  it('reads a stop from elsewhere as a pause, and the next play loads the place again', async () => {
    const t = setup();
    await t.svc.load(TRACKS, 1, 0, [], BOOK);
    t.status({ playerState: 'playing', contentId: t.url(1), position: 80 });
    t.status({ playerState: 'idle', idleReason: 'cancelled', position: NaN });
    expect(t.svc.getSnapshot()).toMatchObject({ state: 'paused', trackIndex: 1, position: 80 });
    await t.svc.play();
    expect(t.remote.play).not.toHaveBeenCalled();
    expect(t.remote.loads.at(-1)).toMatchObject({ startIndex: 1, startTime: 80, autoplay: true });
  });

  it("never touches the receiver's volume (the sleep timer fade would set the TV's)", async () => {
    const t = setup();
    await t.svc.setVolume();
    expect(Object.keys(t.remote)).not.toContain('setVolume');
  });

  it('tells the store about a speed the receiver changed by itself, not one it was just asked for', async () => {
    const t = setup();
    await t.svc.load(TRACKS, 0, 0, [], BOOK);
    await t.svc.setRate(1.5);
    t.status({ playerState: 'playing', contentId: t.url(0), position: 1, rate: 1 }); // stale
    expect(t.rates).toEqual([]);
    t.tick(10_000);
    t.status({ playerState: 'playing', contentId: t.url(0), position: 16, rate: 2 });
    expect(t.rates).toEqual([2]);
    expect(t.svc.getSnapshot().rate).toBe(2);
  });

  it('stops the receiver media on reset', async () => {
    const t = setup();
    await t.svc.load(TRACKS, 0, 0, [], BOOK);
    await t.svc.reset();
    expect(t.remote.stop).toHaveBeenCalled();
    expect(t.svc.getSnapshot().state).toBe('idle');
    expect(t.svc.loadedBook()).toBeNull();
  });

  it('adopts a session it did not load: its place, then its queue for later jumps', async () => {
    const t = setup();
    t.svc.adoptPlace({ state: 'playing', trackIndex: 1, position: 300, duration: 600, rate: 1.25 });
    await t.svc.adoptQueue(TRACKS, BOOK);
    expect(t.svc.loadedBook()).toEqual(BOOK);
    t.status({
      playerState: 'playing',
      contentId: 'https://h/stream?path=A/B/01.mp3&token=CAST',
      position: 301,
    });
    expect(t.svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 301 });
  });

  it('folds a fresh read into the place (a final read before the book goes back)', async () => {
    const t = setup();
    await t.svc.load(TRACKS, 0, 0, [], BOOK);
    (t.remote.readStatus as jest.Mock).mockResolvedValueOnce({
      playerState: 'paused',
      contentId: t.url(2),
      position: 77,
      rate: 1,
    });
    await t.svc.refresh();
    expect(t.svc.getSnapshot()).toMatchObject({ state: 'paused', trackIndex: 2, position: 77 });
  });

  it('stops listening when detached', async () => {
    const t = setup();
    await t.svc.load(TRACKS, 0, 0, [], BOOK);
    t.svc.detach();
    t.status({ playerState: 'playing', contentId: t.url(2), position: 9 });
    expect(t.svc.getSnapshot().trackIndex).toBe(0);
  });
});
