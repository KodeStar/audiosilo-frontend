import type { PlaybackSnapshot, PlaybackTrack } from '@/playback/types';

import { buildCastItems } from './cast-media';
import type { PrepareCast } from './cast-prepare';
import { CastPlaybackService, castState, REMINT_EVERY_MS } from './cast-service';
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

function setup(opts: { transcode?: boolean; prepare?: PrepareCast } = {}) {
  const fake = fakeRemote();
  let clock = 1_000_000;
  const svc = new CastPlaybackService(
    fake.remote,
    opts.prepare ?? prepareWith(opts.transcode),
    () => clock,
  );
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
  it('finding 11: an adopted transcoded item keeps the offset its stream started at', async () => {
    const t = setup({ transcode: true });
    const status: CastMediaStatus = {
      playerState: 'playing',
      customIndex: 0,
      position: 20,
      rate: 1,
      book: BOOK,
      // Sent by the app's previous run: its cast token is not the one this run mints.
      contentId: 'https://h/stream?path=A/B/00.mp3&transcode=1&token=OLD&t=1800',
    };
    // As `adoptReceiverBook` does: the store adopts the place (the router hands it on).
    t.svc.adoptPlace({ state: 'playing', trackIndex: 0, position: 1820, duration: 600, rate: 1 });
    await t.svc.adoptQueue(TRACKS, BOOK, status);
    t.tick(1000);
    t.progress(21);
    expect(t.svc.getSnapshot().position).toBe(1821);
    t.status({ ...status, position: 22 });
    expect(t.svc.getSnapshot().position).toBe(1822);
    expect(t.moves).toEqual([]);
  });

  it('an adopted session follows the receiver into the next file despite its older token', async () => {
    const t = setup();
    const at = (i: number) => `https://h/stream?path=A/B/0${i}.mp3&token=OLD`;
    t.svc.adoptPlace({ state: 'playing', trackIndex: 0, position: 595, duration: 600, rate: 1 });
    await t.svc.adoptQueue(TRACKS, BOOK, {
      playerState: 'playing',
      customIndex: 0,
      position: 595,
      rate: 1,
      book: BOOK,
      contentId: at(0),
    });
    t.tick(6000);
    t.status({ customIndex: 1, position: 1, book: BOOK, contentId: at(1) });
    expect(t.svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 1, state: 'playing' });
  });

  it("finding 6: another person's book on the receiver is not this book's place", async () => {
    const t = setup();
    await t.svc.load(TRACKS, 0, 600, [], BOOK);
    t.status({ contentId: t.url(0), book: BOOK, position: 600 });
    t.tick(10_000);
    // Bob's phone loads his book (his connection) on the same receiver.
    const bobs = { ...BOOK, connectionId: 'srv.9' };
    t.status({ customIndex: 0, position: 30, rate: 2, book: bobs, contentId: t.url(0) });
    t.progress(31);
    t.status({ customIndex: 0, position: 32, rate: 2, book: bobs, contentId: t.url(0) });
    expect(t.svc.getSnapshot()).toMatchObject({ position: 600, rate: 1, state: 'paused' });
    expect(t.moves).toEqual([]);
    expect(t.rates).toEqual([]);
    // Playing here again puts this book back on the receiver, at its place.
    await t.svc.play();
    expect(t.remote.loads).toHaveLength(2);
    expect(t.remote.loads[1].book).toEqual(BOOK);
  });

  it("another app's media on the same receiver (none of our data) is not this book's place", async () => {
    const t = setup();
    await t.svc.load(TRACKS, 2, 500, [], BOOK); // the book's last file, at 500
    t.status({ contentId: t.url(2), book: BOOK, position: 500 });
    t.tick(10_000);
    // A Home Assistant announcement, a podcast app: its own URL, a one-item queue.
    const theirs = {
      contentId: 'https://cdn.example/news.mp3',
      currentItemId: 7,
      queueItemIds: [7],
    };
    t.status({ ...theirs, position: 30 });
    t.progress(31);
    t.status({ ...theirs, playerState: 'idle', idleReason: 'finished', position: 0 });
    // Never this book's place, never a move, never the book's end.
    expect(t.svc.getSnapshot()).toMatchObject({ trackIndex: 2, position: 500, state: 'paused' });
    expect(t.moves).toEqual([]);
    // Playing here puts this book back on the receiver, at its place.
    await t.svc.play();
    expect(t.remote.loads.at(-1)).toMatchObject({ book: BOOK, startIndex: 2, startTime: 500 });
  });

  it("a receiver another sender took over: this phone's controls leave their media alone", async () => {
    const t = setup();
    await t.svc.load(TRACKS, 0, 600, [], BOOK);
    t.status({ contentId: t.url(0), book: BOOK, position: 600 });
    const bobs = { ...BOOK, connectionId: 'srv.9' };
    t.status({ customIndex: 0, position: 30, book: bobs, contentId: t.url(0) });
    expect(t.svc.getSnapshot().state).toBe('paused');
    // A speed change, a pause, a seek, a chapter in another file, a stop (a switch of
    // person, Mark as finished): none of them reaches the receiver.
    await t.svc.setRate(1.8);
    await t.svc.pause();
    await t.svc.seekTo(900);
    await t.svc.skipToTrack(1, 20);
    await t.svc.reset();
    expect(t.remote.setRate).not.toHaveBeenCalled();
    expect(t.remote.pause).not.toHaveBeenCalled();
    expect(t.remote.seek).not.toHaveBeenCalled();
    expect(t.remote.stop).not.toHaveBeenCalled();
    expect(t.remote.loads).toHaveLength(1);
  });

  it('a load that was started earlier but prepared later stands back for the newer one', async () => {
    const fake = fakeRemote();
    const gates: (() => void)[] = [];
    const prepare: PrepareCast = (tracks, book) =>
      new Promise((resolve) => {
        gates.push(() => resolve({ items: buildCastItems(tracks, book, urls, false) }));
      });
    const svc = new CastPlaybackService(fake.remote, prepare);
    const other = { ...BOOK, path: 'C/D' };
    const first = svc.load(TRACKS, 0, 50, [], BOOK); // its cast token is being minted
    const second = svc.load(TRACKS, 1, 20, [], other); // its token was cached
    gates[1]();
    await second;
    gates[0]();
    await first;
    // The receiver keeps the newer book, and that is the book whose statuses count.
    expect(fake.remote.loads.map((l) => l.book)).toEqual([other]);
    fake.status({ contentId: fake.remote.loads[0].items[1].url, book: other, position: 25 });
    expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 25 });
  });

  it("a queue the receiver rejected because a newer one replaced it is not this load's failure", async () => {
    const t = setup();
    let reject!: (e: unknown) => void;
    (t.remote.load as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, r) => {
          reject = r;
        }),
    );
    const first = t.svc.load(TRACKS, 0, 0, [], BOOK);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await t.svc.skipToTrack(2, 0); // a chapter in another file before the load answered
    reject(new Error('REPLACED'));
    await expect(first).resolves.toBeUndefined();
    expect(t.svc.getSnapshot()).toMatchObject({ trackIndex: 2, position: 0 });
  });

  it('a receiver book named by its legacy connection id is still ours', async () => {
    const { setConnectionAliases } =
      jest.requireActual<typeof import('@/lib/connection-id')>('@/lib/connection-id');
    setConnectionAliases({ srv: 'srv.3' });
    try {
      const t = setup();
      await t.svc.load(TRACKS, 0, 10, [], BOOK);
      t.status({ contentId: t.url(0), book: { ...BOOK, connectionId: 'srv' }, position: 12 });
      expect(t.svc.getSnapshot()).toMatchObject({ position: 12, state: 'playing' });
    } finally {
      setConnectionAliases({});
    }
  });

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

  // fe#211: told after its landed place, the store's save, cut or keep could end the
  // listening span at the landed place first, and the move then read as one to nowhere.
  it('tells the store of a move before its listeners take the landed place', async () => {
    const t = setup();
    await t.svc.load(TRACKS, 0, 100, [], BOOK);
    t.tick(10_000);
    t.status({ playerState: 'playing', contentId: t.url(0), position: 100 });
    t.tick(1_000);
    const from = t.snaps.length;
    const heard = () => t.snaps.slice(from).map((s) => [s.trackIndex, s.position]);
    let heardWhenMoved: number[][] | null = null;
    t.svc.onRemoteMove(() => {
      heardWhenMoved = heard();
    });
    t.status({ playerState: 'playing', contentId: t.url(1), position: 42 }); // the next chapter
    expect(heardWhenMoved).toEqual([]);
    expect(heard()).toEqual([[1, 42]]);
  });

  it('gives its listeners the landed place even when the move’s handler throws', async () => {
    const t = setup();
    await t.svc.load(TRACKS, 0, 100, [], BOOK);
    t.tick(10_000);
    t.status({ playerState: 'playing', contentId: t.url(0), position: 100 });
    t.tick(1_000);
    t.svc.onRemoteMove(() => {
      throw new Error('handler failed');
    });
    expect(() => t.status({ playerState: 'playing', contentId: t.url(0), position: 20 })).toThrow(
      'handler failed',
    );
    expect(t.snaps.at(-1)).toMatchObject({ trackIndex: 0, position: 20 });
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

  describe('finding 6: a stream that ends before the last file does', () => {
    it('is not the end of the book: the queue loads again at the place and plays on', async () => {
      const t = setup({ transcode: true });
      await t.svc.load(TRACKS, 2, 0, [], BOOK);
      t.status({ playerState: 'playing', contentId: t.url(2), position: 298 });
      t.tick(2_000);
      // The server or a proxy closed the stream: the receiver calls it finished, at 0.
      t.status({ playerState: 'idle', idleReason: 'finished', contentId: t.url(2), position: 0 });
      expect(t.snaps.some((s) => s.state === 'ended')).toBe(false);
      expect(t.svc.getSnapshot()).toMatchObject({ trackIndex: 2, position: 300 });
      const req = t.remote.loads.at(-1)!;
      expect(t.remote.loads).toHaveLength(2);
      expect(req).toMatchObject({ startIndex: 2, autoplay: true });
      expect(req.items[2].url).toContain('t=300');
    });

    it('ends the book when the reloaded stream ends again without getting further', async () => {
      const t = setup({ transcode: true });
      await t.svc.load(TRACKS, 2, 0, [], BOOK);
      t.status({ playerState: 'playing', contentId: t.url(2), position: 300 });
      t.status({ playerState: 'idle', idleReason: 'finished', contentId: t.url(2), position: 0 });
      t.status({ playerState: 'playing', contentId: t.url(2), position: 1 });
      t.status({ playerState: 'idle', idleReason: 'finished', contentId: t.url(2), position: 0 });
      expect(t.svc.getSnapshot()).toMatchObject({ state: 'ended', position: 600 });
      expect(t.remote.loads).toHaveLength(2);
    });

    it('seen long ago (a suspended iPhone): back paused at that place, never played from it', async () => {
      const t = setup({ transcode: true });
      await t.svc.load(TRACKS, 2, 0, [], BOOK);
      t.status({ playerState: 'playing', contentId: t.url(2), position: 120 });
      t.tick(60_000);
      t.status({ playerState: 'idle', idleReason: 'finished', contentId: t.url(2), position: 0 });
      expect(t.svc.getSnapshot()).toMatchObject({ state: 'paused', trackIndex: 2 });
      expect(t.remote.loads).toHaveLength(1);
      await t.svc.play();
      expect(t.remote.loads).toHaveLength(2);
      expect(t.remote.loads.at(-1)).toMatchObject({ startIndex: 2, autoplay: true });
    });
  });

  describe('a cast token the server ended (its per-person cap, fe#158)', () => {
    /** A prepare whose URLs carry the token it was given: `CAST0` cached, then one more per
     * fresh mint. */
    function minting() {
      let minted = 0;
      const asks: (boolean | undefined)[] = [];
      const prepare: PrepareCast = async (tracks, book, opts) => {
        asks.push(opts?.freshToken);
        if (opts?.freshToken) minted++;
        const token = `CAST${minted}`;
        return {
          items: buildCastItems(
            tracks,
            book,
            {
              streamUrl: (_l: number, path: string) =>
                `https://h/stream?path=${path}&token=${token}`,
              coverUrl: () => `https://h/cover?token=${token}`,
            },
            false,
          ),
        };
      };
      return { prepare, asks };
    }

    it('a load the receiver refuses is sent again with a newly minted token', async () => {
      const m = minting();
      const t = setup({ prepare: m.prepare });
      (t.remote.load as jest.Mock).mockRejectedValueOnce(new Error('LOAD_FAILED'));
      await t.svc.load(TRACKS, 1, 30, [], BOOK);
      expect(m.asks).toEqual([undefined, true]);
      expect(t.remote.load).toHaveBeenCalledTimes(2);
      expect(t.remote.loads.at(-1)).toMatchObject({ startIndex: 1, startTime: 30 });
      expect(t.url(0)).toContain('token=CAST1');
      expect(t.svc.getSnapshot()).toMatchObject({ state: 'ready', trackIndex: 1, position: 30 });
    });

    it('a load refused again with the new token fails', async () => {
      const m = minting();
      const t = setup({ prepare: m.prepare });
      (t.remote.load as jest.Mock).mockRejectedValue(new Error('LOAD_FAILED'));
      await expect(t.svc.load(TRACKS, 0, 0, [], BOOK)).rejects.toThrow('LOAD_FAILED');
      expect(m.asks).toEqual([undefined, true]);
    });

    it('a receiver error mid-book reloads there with a new token and plays on', async () => {
      const m = minting();
      const t = setup({ prepare: m.prepare });
      await t.svc.load(TRACKS, 0, 0, [], BOOK);
      await t.svc.play();
      t.status({ playerState: 'playing', contentId: t.url(1), position: 42 });
      // The next request for the file is refused: the receiver stops on an error, at 0.
      t.status({ playerState: 'idle', idleReason: 'error', contentId: t.url(1), position: 0 });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(t.snaps.some((s) => s.state === 'error')).toBe(false);
      expect(m.asks).toEqual([undefined, true]);
      expect(t.remote.loads.at(-1)).toMatchObject({ startIndex: 1, startTime: 42, autoplay: true });
      expect(t.url(1)).toContain('token=CAST1');
      expect(t.svc.getSnapshot()).toMatchObject({ state: 'loading', trackIndex: 1, position: 42 });
    });

    it('a paused receiver reloaded after an error stays paused', async () => {
      const m = minting();
      const t = setup({ prepare: m.prepare });
      await t.svc.load(TRACKS, 0, 0, [], BOOK);
      t.status({ playerState: 'paused', contentId: t.url(0), position: 10 });
      t.status({ playerState: 'idle', idleReason: 'error', contentId: t.url(0), position: 0 });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(t.remote.loads.at(-1)).toMatchObject({
        startIndex: 0,
        startTime: 10,
        autoplay: false,
      });
      expect(t.svc.getSnapshot()).toMatchObject({ state: 'paused', position: 10 });
    });

    it('a paused book whose seek is refused reloads paused, though the receiver was buffering', async () => {
      const m = minting();
      const t = setup({ prepare: m.prepare });
      await t.svc.load(TRACKS, 0, 0, [], BOOK);
      await t.svc.play();
      t.status({ playerState: 'playing', contentId: t.url(0), position: 10 });
      await t.svc.pause();
      t.status({ playerState: 'paused', contentId: t.url(0), position: 10 });
      await t.svc.seekTo(300);
      // The receiver buffers the seek, and its request is refused with the ended token.
      t.status({ playerState: 'buffering', contentId: t.url(0), position: 300 });
      expect(t.svc.getSnapshot().state).toBe('loading');
      t.status({ playerState: 'idle', idleReason: 'error', contentId: t.url(0), position: 0 });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(m.asks).toEqual([undefined, true]);
      expect(t.remote.loads.at(-1)).toMatchObject({
        startIndex: 0,
        startTime: 300,
        autoplay: false,
      });
      expect(t.svc.getSnapshot()).toMatchObject({ state: 'paused', position: 300 });
    });

    it('a playing book refused while it buffers plays on', async () => {
      const m = minting();
      const t = setup({ prepare: m.prepare });
      await t.svc.load(TRACKS, 0, 0, [], BOOK);
      await t.svc.play();
      t.status({ playerState: 'buffering', contentId: t.url(0), position: 10 });
      t.status({ playerState: 'idle', idleReason: 'error', contentId: t.url(0), position: 0 });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(t.remote.loads.at(-1)).toMatchObject({ startTime: 10, autoplay: true });
    });

    it('an adopted session reloads in the play state it was taken over in', async () => {
      const m = minting();
      const t = setup({ prepare: m.prepare });
      const status: CastMediaStatus = {
        playerState: 'paused',
        customIndex: 0,
        position: 20,
        rate: 1,
        book: BOOK,
        contentId: 'https://h/stream?path=A/B/00.mp3&token=CAST0',
      };
      t.svc.adoptPlace({ state: 'paused', trackIndex: 0, position: 20, duration: 600, rate: 1 });
      await t.svc.adoptQueue(TRACKS, BOOK, status);
      t.status({ ...status, playerState: 'buffering', position: 200 });
      t.status({ ...status, playerState: 'idle', idleReason: 'error', position: 0 });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(t.remote.loads.at(-1)).toMatchObject({ startTime: 200, autoplay: false });
      expect(t.svc.getSnapshot()).toMatchObject({ state: 'paused', position: 200 });
    });

    it('a second error soon after is the error: no token minted on every try', async () => {
      const m = minting();
      const t = setup({ prepare: m.prepare });
      await t.svc.load(TRACKS, 0, 0, [], BOOK);
      t.status({ playerState: 'playing', contentId: t.url(0), position: 5 });
      t.status({ playerState: 'idle', idleReason: 'error', contentId: t.url(0), position: 0 });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      t.tick(REMINT_EVERY_MS - 1);
      t.status({ playerState: 'idle', idleReason: 'error', contentId: t.url(0), position: 0 });
      expect(t.svc.getSnapshot().state).toBe('error');
      expect(m.asks).toEqual([undefined, true]);
      expect(t.remote.loads).toHaveLength(2);
    });

    it('a second move refused while the token is minted is sent again too, after the first', async () => {
      let minted: () => void = () => {};
      const asks: (boolean | undefined)[] = [];
      const t = setup({
        prepare: async (tracks, book, opts) => {
          asks.push(opts?.freshToken);
          if (opts?.freshToken) await new Promise<void>((resolve) => (minted = resolve));
          return { items: buildCastItems(tracks, book, urls, false) };
        },
      });
      await t.svc.load(TRACKS, 0, 0, [], BOOK);
      (t.remote.load as jest.Mock)
        .mockRejectedValueOnce(new Error('LOAD_FAILED'))
        .mockRejectedValueOnce(new Error('LOAD_FAILED'));
      const first = t.svc.skipToTrack(1, 10);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      const second = t.svc.skipToTrack(0, 20);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      minted();
      await Promise.all([first, second]);
      expect(asks).toEqual([undefined, true]);
      expect(t.remote.loads.at(-1)).toMatchObject({ startIndex: 0, startTime: 20 });
      expect(t.svc.getSnapshot()).toMatchObject({ trackIndex: 0, position: 20 });
    });

    it('another book refused while a mint is on its way asks for its own', async () => {
      let minted: () => void = () => {};
      const asks: [string, boolean | undefined][] = [];
      const t = setup({
        prepare: async (tracks, book, opts) => {
          asks.push([book.path, opts?.freshToken]);
          if (opts?.freshToken && book.path === BOOK.path) {
            await new Promise<void>((resolve) => (minted = resolve));
          }
          return { items: buildCastItems(tracks, book, urls, false) };
        },
      });
      await t.svc.load(TRACKS, 0, 0, [], BOOK);
      (t.remote.load as jest.Mock)
        .mockRejectedValueOnce(new Error('LOAD_FAILED'))
        .mockRejectedValueOnce(new Error('LOAD_FAILED'));
      const move = t.svc.skipToTrack(1, 10);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      // The other book's own load is refused while the first book's mint is still out.
      await t.svc.load(TRACKS, 0, 0, [], { ...BOOK, path: 'A/C' });
      expect(asks.slice(-2)).toEqual([
        ['A/C', undefined],
        ['A/C', true],
      ]);
      expect(t.remote.loads.at(-1)).toMatchObject({ book: { path: 'A/C' } });
      // The first book's mint lands on a receiver that is the other book's now: not sent.
      const sent = t.remote.loads.length;
      minted();
      await expect(move).rejects.toThrow('LOAD_FAILED');
      expect(t.remote.loads).toHaveLength(sent);
    });

    it('an error already shown is not reloaded when the receiver says it again later', async () => {
      const m = minting();
      const t = setup({ prepare: m.prepare });
      await t.svc.load(TRACKS, 0, 0, [], BOOK);
      t.status({ playerState: 'playing', contentId: t.url(0), position: 5 });
      t.status({ playerState: 'idle', idleReason: 'error', contentId: t.url(0), position: 0 });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      t.status({ playerState: 'idle', idleReason: 'error', contentId: t.url(0), position: 0 });
      expect(t.svc.getSnapshot().state).toBe('error');
      // A minute on the app comes back and reads the receiver's status: still the error.
      t.tick(REMINT_EVERY_MS);
      t.status({ playerState: 'idle', idleReason: 'error', contentId: t.url(0), position: 0 });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(t.svc.getSnapshot().state).toBe('error');
      expect(m.asks).toEqual([undefined, true]);
      expect(t.remote.loads).toHaveLength(2);
    });

    it('a book loaded again (a Retry) mints no sooner than a minute on; another book may', async () => {
      const m = minting();
      const t = setup({ prepare: m.prepare });
      (t.remote.load as jest.Mock).mockRejectedValueOnce(new Error('LOAD_FAILED'));
      await t.svc.load(TRACKS, 0, 0, [], BOOK);
      expect(m.asks).toEqual([undefined, true]);
      // Refused again: the Retry's load, after a reset, mints nothing within the minute.
      (t.remote.load as jest.Mock).mockRejectedValueOnce(new Error('LOAD_FAILED'));
      await t.svc.reset();
      t.tick(REMINT_EVERY_MS - 1);
      await expect(t.svc.load(TRACKS, 0, 0, [], BOOK)).rejects.toThrow('LOAD_FAILED');
      expect(m.asks).toEqual([undefined, true, undefined]);
      // A minute on: again.
      t.tick(1);
      (t.remote.load as jest.Mock).mockRejectedValueOnce(new Error('LOAD_FAILED'));
      await t.svc.load(TRACKS, 0, 0, [], BOOK);
      expect(m.asks).toEqual([undefined, true, undefined, undefined, true]);
      // Another book: at once.
      (t.remote.load as jest.Mock).mockRejectedValueOnce(new Error('LOAD_FAILED'));
      await t.svc.load(TRACKS, 0, 0, [], { ...BOOK, path: 'A/C' });
      expect(m.asks.slice(-2)).toEqual([undefined, true]);
    });

    it('a mint that fails leaves the error', async () => {
      const t = setup({
        prepare: async (tracks, book, opts) => {
          if (opts?.freshToken) throw new Error('offline');
          return { items: buildCastItems(tracks, book, urls, false) };
        },
      });
      await t.svc.load(TRACKS, 0, 0, [], BOOK);
      t.status({ playerState: 'playing', contentId: t.url(0), position: 5 });
      t.status({ playerState: 'idle', idleReason: 'error', contentId: t.url(0), position: 0 });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(t.svc.getSnapshot().state).toBe('error');
      expect(t.remote.loads).toHaveLength(1);
    });
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
  });

  it('adopts a session it did not load: its place, then its queue for later jumps', async () => {
    const t = setup();
    t.svc.adoptPlace({ state: 'playing', trackIndex: 1, position: 300, duration: 600, rate: 1.25 });
    await t.svc.adoptQueue(TRACKS, BOOK);
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
