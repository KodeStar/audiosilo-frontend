import {
  createPlaybackService,
  isSwapReady,
  routePickerKind,
  sourceFor,
  VOICE_BOOST_COMPRESSOR,
  VOICE_BOOST_LIMITER,
  VOICE_BOOST_TRIM_DB,
} from './service.web';
import {
  AutoplayBlockedError,
  type PlaybackConfig,
  type PlaybackService,
  type PlaybackState,
  type PlaybackTrack,
} from './types';

// HTMLMediaElement.readyState levels (numeric so the test reads like the browser).
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;
const HAVE_ENOUGH_DATA = 4;

describe('isSwapReady', () => {
  it('is ready when it can play through AND the playhead is at the seek target', () => {
    expect(isSwapReady(HAVE_FUTURE_DATA, 30, 30)).toBe(true);
    expect(isSwapReady(HAVE_ENOUGH_DATA, 30.4, 30)).toBe(true); // within ~1.5s tolerance
  });

  it('is not ready until it can play through', () => {
    expect(isSwapReady(HAVE_CURRENT_DATA, 30, 30)).toBe(false);
    expect(isSwapReady(0, 30, 30)).toBe(false);
  });

  it('is not ready until the playhead reaches the target', () => {
    expect(isSwapReady(HAVE_FUTURE_DATA, 0, 30)).toBe(false); // seek not applied yet
    expect(isSwapReady(HAVE_FUTURE_DATA, 28, 30)).toBe(false); // 2s off > tolerance
  });

  it('treats a falsy target as the start of the track', () => {
    expect(isSwapReady(HAVE_FUTURE_DATA, 0.5, 0)).toBe(true);
    expect(isSwapReady(HAVE_FUTURE_DATA, 2, 0)).toBe(false);
  });
});

describe('routePickerKind', () => {
  it('prefers AirPlay when the Safari/iOS picker is available', () => {
    expect(
      routePickerKind({
        webkitShowPlaybackTargetPicker: () => {},
        remote: { prompt: () => Promise.resolve() }, // AirPlay wins even if both exist
      }),
    ).toBe('airplay');
  });

  it('falls back to the Remote Playback API (Cast) when only it is available', () => {
    expect(routePickerKind({ remote: { prompt: () => Promise.resolve() } })).toBe('remote');
  });

  it('is none when neither API is present', () => {
    expect(routePickerKind({})).toBe('none');
    expect(routePickerKind({ remote: null })).toBe('none');
    expect(routePickerKind({ remote: {} })).toBe('none'); // remote object without prompt()
  });
});

// --- The engine over a fake <audio> --------------------------------------------
// Models the parts of HTMLMediaElement the engine leans on, including the load
// algorithm's reset of `currentTime` and of `playbackRate` to `defaultPlaybackRate`
// (which is what a transcoded seek, a new src each time, runs into), its silent pause
// (no 'pause' event, so a pause() inside a load fires none either), and the natural
// end's 'pause' before 'ended'.
class FakeAudio {
  static all: FakeAudio[] = [];
  src = '';
  preload = '';
  volume = 1;
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  ended = false;
  readyState = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  loads = 0;
  plays = 0;
  private listeners = new Map<string, Set<() => void>>();
  constructor() {
    FakeAudio.all.push(this);
  }
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  load() {
    this.loads++;
    this.currentTime = 0;
    this.ended = false;
    this.paused = true; // silently: the load algorithm fires no 'pause'
    this.playbackRate = this.defaultPlaybackRate;
  }
  play() {
    this.plays++;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return; // already paused: no event
    this.paused = true;
    this.emit('pause');
  }
  /** Play out to the end of the resource: the element pauses itself, then ends. */
  reachEnd() {
    this.ended = true;
    if (!this.paused) {
      this.paused = true;
      this.emit('pause');
    }
    this.emit('ended');
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
}

const STREAM = 'https://s/api/v1/libraries/2/stream?path=A%2F01.ac3&transcode=1&token=k';
const STREAM2 = 'https://s/api/v1/libraries/2/stream?path=A%2F02.ac3&transcode=1&token=k';
const transcodedTracks: PlaybackTrack[] = [
  { id: '2:A/01.ac3', url: STREAM, title: 'B', duration: 1000, transcoded: true },
  { id: '2:A/02.ac3', url: STREAM2, title: 'B', duration: 500, transcoded: true },
];
// Two ordinary files (one chapter per file, the server's default for a chapterless
// folder of MP3s), streamed directly.
const FILE1 = 'https://s/api/v1/libraries/2/stream?path=C%2F01.mp3&token=k';
const FILE2 = 'https://s/api/v1/libraries/2/stream?path=C%2F02.mp3&token=k';
const directTracks: PlaybackTrack[] = [
  { id: '2:C/01.mp3', url: FILE1, title: 'C', duration: 600 },
  { id: '2:C/02.mp3', url: FILE2, title: 'C', duration: 900 },
];

/** The active element: the most recently created one the engine kept. */
const el = () => FakeAudio.all[FakeAudio.all.length - 1];

describe('WebPlaybackService (transcoded tracks)', () => {
  const realAudio = (globalThis as { Audio?: unknown }).Audio;
  let svc: PlaybackService;
  let now = 1_000_000;

  beforeEach(() => {
    FakeAudio.all = [];
    (globalThis as { Audio?: unknown }).Audio = FakeAudio;
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    svc = createPlaybackService();
  });
  afterEach(() => {
    (globalThis as { Audio?: unknown }).Audio = realAudio;
    jest.restoreAllMocks();
  });

  /** Load at `position` and get the engine to `playing`. */
  async function startPlaying(position = 0) {
    await svc.load(transcodedTracks, 0, position);
    el().emit('loadedmetadata');
    await svc.play();
    el().emit('playing');
  }

  it('requests the stream at the start position and reports track-absolute time', async () => {
    await svc.load(transcodedTracks, 0, 250);
    const a = el();
    expect(a.src).toBe(`${STREAM}&t=250`);
    expect(svc.getSnapshot()).toMatchObject({ position: 250, duration: 1000 });
    a.emit('loadedmetadata');
    expect(a.currentTime).toBe(0); // never seeks the element itself
    a.currentTime = 5;
    a.emit('timeupdate');
    expect(svc.getSnapshot().position).toBe(255);
    // The element can't know the length: the queue's duration stands.
    a.duration = Number.POSITIVE_INFINITY;
    a.emit('durationchange');
    a.duration = 12; // a partial read of the remaining output
    a.emit('durationchange');
    expect(svc.getSnapshot().duration).toBe(1000);
  });

  it('starts at the top with no t at 0', async () => {
    await svc.load(transcodedTracks, 0, 0);
    expect(el().src).toBe(STREAM);
  });

  it('seeks by re-requesting at the target, keeping play and the rate', async () => {
    await startPlaying(100);
    await svc.setRate(1.5);
    const a = el();
    const plays = a.plays;
    await svc.seekTo(600);
    expect(a.src).toBe(`${STREAM}&t=600`);
    expect(svc.getSnapshot()).toMatchObject({ position: 600, state: 'loading' });
    // The load algorithm reset playbackRate to the default; the engine set both.
    expect(a.playbackRate).toBe(1.5);
    a.emit('loadedmetadata');
    expect(a.plays).toBe(plays + 1); // resumed
    a.currentTime = 3;
    a.emit('timeupdate');
    expect(svc.getSnapshot().position).toBe(603);
  });

  it('a seek while paused reloads without playing', async () => {
    await svc.load(transcodedTracks, 0, 100);
    el().emit('loadedmetadata');
    const plays = el().plays;
    await svc.seekTo(40);
    el().emit('loadedmetadata');
    expect(el().src).toBe(`${STREAM}&t=40`);
    expect(el().plays).toBe(plays);
  });

  it('a second seek inside the reload window still resumes, once', async () => {
    await startPlaying(100);
    const a = el();
    const plays = a.plays;
    await svc.seekTo(300); // now `loading`
    await svc.seekTo(400); // before the first reload's metadata arrived
    a.emit('loadedmetadata'); // both handlers see it; only the latest load acts
    expect(a.src).toBe(`${STREAM}&t=400`);
    expect(a.plays).toBe(plays + 1);
  });

  it('a pause inside the reload window holds: the new stream does not start', async () => {
    await startPlaying(100);
    const a = el();
    const plays = a.plays;
    await svc.seekTo(600); // reloads, meaning to play on
    await svc.pause(); // e.g. the sleep timer firing before the new stream loaded
    expect(svc.getSnapshot()).toMatchObject({ state: 'paused', position: 600 });
    a.emit('loadedmetadata');
    expect(a.plays).toBe(plays);
    expect(a.paused).toBe(true);
    expect(svc.getSnapshot().state).toBe('paused');
    // The play button still starts it from there.
    await svc.play();
    expect(a.src).toBe(`${STREAM}&t=600`);
    expect(a.plays).toBe(plays + 1);
  });

  it('a seek during a network stall keeps playing', async () => {
    await startPlaying(100);
    const a = el();
    a.emit('waiting'); // the stream stalls: `loading`, but the element is not paused
    expect(svc.getSnapshot().state).toBe('loading');
    const plays = a.plays;
    await svc.seekTo(600); // a skip while it buffers
    a.emit('loadedmetadata');
    expect(a.src).toBe(`${STREAM}&t=600`);
    expect(a.plays).toBe(plays + 1); // not left paused for the stall watchdog to error
  });

  it('a new load forgets the pause before it: no early start, no extra request', async () => {
    await svc.configure({
      autoRewindMax: 30,
      jumpForward: 30,
      jumpBackward: 15,
      smartSpeed: false,
      voiceBoost: false,
    });
    await startPlaying(200);
    await svc.pause();
    now += 10 * 60_000; // long enough to read as a stale transcode
    await svc.load(transcodedTracks, 1, 50); // another chapter or book, from 50 s
    el().emit('loadedmetadata');
    await svc.play();
    expect(el().src).toBe(`${STREAM2}&t=50`); // not re-requested 30 s early
    expect(el().paused).toBe(false);
  });

  it('clamps a seek into the file, short of its very end', async () => {
    await startPlaying(0);
    await svc.seekTo(5000);
    expect(el().src).toBe(`${STREAM}&t=999`);
    await svc.seekTo(-20);
    expect(el().src).toBe(STREAM);
  });

  it('a seek to the very end requests the last second, not an empty stream', async () => {
    await startPlaying(100);
    const a = el();
    await svc.seekTo(1000); // skip forward / a drag to the end of the file
    expect(a.src).toBe(`${STREAM}&t=999`);
    expect(svc.getSnapshot()).toMatchObject({ position: 999, state: 'loading' });
    // That last second plays out and the file ends for real: on to the next one.
    a.emit('loadedmetadata');
    a.emit('playing');
    a.currentTime = 1;
    a.emit('timeupdate');
    expect(svc.getSnapshot().position).toBe(1000);
    a.reachEnd();
    expect(a.src).toBe(STREAM2);
    expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 0 });
  });

  it('skipToTrack requests the other file at its position', async () => {
    await startPlaying(0);
    await svc.skipToTrack(1, 50);
    expect(el().src).toBe(`${STREAM2}&t=50`);
    expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 50, duration: 500 });
  });

  it('a load (the store retry path) reloads at the track-absolute position', async () => {
    await startPlaying(100);
    el().currentTime = 20;
    el().emit('timeupdate'); // at 120
    await svc.load(transcodedTracks, 0, svc.getSnapshot().position);
    expect(el().src).toBe(`${STREAM}&t=120`);
  });

  it('auto-rewind on resume re-requests further back', async () => {
    await svc.configure({
      autoRewindMax: 30,
      jumpForward: 30,
      jumpBackward: 15,
      smartSpeed: false,
      voiceBoost: false,
    });
    await startPlaying(200);
    el().currentTime = 10;
    el().emit('timeupdate'); // at 210
    await svc.pause();
    now += 8_000; // paused 8s -> rewind 8s
    await svc.play();
    expect(el().src).toBe(`${STREAM}&t=202`);
    el().emit('loadedmetadata');
    expect(el().paused).toBe(false);
  });

  it('a short pause resumes the same connection', async () => {
    await startPlaying(200);
    const src = el().src;
    await svc.pause();
    now += 5_000;
    await svc.play();
    expect(el().src).toBe(src);
    expect(el().paused).toBe(false);
  });

  it('a long pause re-requests at the position (the transcode may be gone)', async () => {
    await startPlaying(200);
    el().currentTime = 30;
    el().emit('timeupdate'); // at 230
    await svc.pause();
    now += 10 * 60_000;
    await svc.play();
    expect(el().src).toBe(`${STREAM}&t=230`);
  });

  it('an early end reloads where it stopped; a real end advances', async () => {
    await startPlaying(0);
    const a = el();
    a.currentTime = 400;
    a.emit('ended'); // the connection died at 400 of 1000
    expect(a.src).toBe(`${STREAM}&t=400`);
    expect(svc.getSnapshot().trackIndex).toBe(0);
    // It dies again without real progress: accept it as the end and move on.
    a.currentTime = 1;
    a.emit('ended');
    expect(a.src).toBe(STREAM2);
    expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 0 });
    // The next file finishing normally ends the book.
    a.currentTime = 498;
    a.emit('ended');
    expect(svc.getSnapshot().state).toBe('ended');
  });

  it('swaps from a transcoded stream to the local copy with no offset left over', async () => {
    jest.useFakeTimers();
    try {
      await startPlaying(300);
      const streaming = el();
      const local: PlaybackTrack[] = transcodedTracks.map((t, i) => ({
        id: t.id,
        url: `file:///local/${i}.ac3`,
        title: t.title,
        duration: t.duration,
      }));
      const swap = svc.swapTo!(local, 0, 300);
      const pending = el();
      expect(pending).not.toBe(streaming);
      expect(pending.src).toBe('file:///local/0.ac3');
      pending.emit('loadedmetadata');
      expect(pending.currentTime).toBe(300); // a local file seeks in place
      pending.readyState = 4;
      pending.emit('canplay');
      expect(await swap).toBe(true);
      expect(streaming.src).toBe(''); // the transcode connection is closed
      pending.currentTime = 310;
      pending.emit('timeupdate');
      expect(svc.getSnapshot().position).toBe(310); // not 310 + the old offset
      // ...and a seek on the local file is an ordinary in-place seek.
      const loads = pending.loads;
      await svc.seekTo(50);
      expect(pending.loads).toBe(loads);
      expect(pending.currentTime).toBe(50);
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves a direct stream exactly as before', async () => {
    const direct: PlaybackTrack[] = [{ id: '2:x', url: 'https://s/x.mp3?token=k', title: 'B' }];
    await svc.load(direct, 0, 70);
    const a = el();
    expect(a.src).toBe('https://s/x.mp3?token=k');
    a.emit('loadedmetadata');
    expect(a.currentTime).toBe(70); // seeks the element itself
    a.duration = 900;
    a.emit('durationchange');
    expect(svc.getSnapshot().duration).toBe(900);
    const loads = a.loads;
    await svc.seekTo(120);
    expect(a.loads).toBe(loads); // byte-range seek, no reload
    expect(a.currentTime).toBe(120);
  });
});

describe('WebPlaybackService file boundaries (direct tracks)', () => {
  const realAudio = (globalThis as { Audio?: unknown }).Audio;
  let svc: PlaybackService;
  /** Every state the engine reported, in order. */
  let states: PlaybackState[];

  beforeEach(() => {
    FakeAudio.all = [];
    (globalThis as { Audio?: unknown }).Audio = FakeAudio;
    svc = createPlaybackService();
    states = [];
    svc.subscribe((s) => void states.push(s.state));
  });
  afterEach(() => {
    (globalThis as { Audio?: unknown }).Audio = realAudio;
  });

  /** Load file `index` and get the engine to `playing`; `states` records from there. */
  async function startPlaying(index: number) {
    await svc.load(directTracks, index, 0);
    el().emit('loadedmetadata');
    await svc.play();
    el().emit('playing');
    states.length = 0;
  }

  it('moves on at the natural end of a file without ever reporting a pause', async () => {
    await startPlaying(0);
    const a = el();
    const plays = a.plays;
    a.reachEnd(); // 'pause', then 'ended'
    expect(a.src).toBe(FILE2);
    expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 0, state: 'loading' });
    a.emit('loadedmetadata');
    expect(a.plays).toBe(plays + 1); // the next file starts on its own
    a.emit('playing');
    // No 'paused' in between: the store keeps its play intent across the boundary.
    expect(states).toEqual(['loading', 'playing']);
  });

  it('still reports the pause, then the end, at the end of the last file', async () => {
    await startPlaying(1);
    el().reachEnd();
    expect(states).toEqual(['paused', 'ended']);
  });

  it('a pause while the next file loads holds: it does not start on its own', async () => {
    await startPlaying(0);
    const a = el();
    a.reachEnd(); // on to file 2, meaning to play
    const plays = a.plays;
    await svc.pause(); // e.g. the sleep timer stopping the book at this chapter's end
    a.emit('loadedmetadata');
    expect(a.plays).toBe(plays);
    expect(a.paused).toBe(true);
    expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, state: 'paused' });
  });

  it('a skip while the next file loads keeps playing', async () => {
    await startPlaying(0);
    const a = el();
    a.reachEnd(); // file 2 loading, not playing yet
    await svc.skipToTrack(0, 30); // e.g. a chapter picked before it started
    const plays = a.plays;
    a.emit('loadedmetadata');
    expect(a.src).toBe(FILE1);
    expect(a.currentTime).toBe(30);
    expect(a.plays).toBe(plays + 1);
  });

  it('a file that fails to load leaves no intent to play behind', async () => {
    await startPlaying(0);
    const a = el();
    a.reachEnd(); // file 2 loading, meaning to play...
    a.emit('error'); // ...but it never loads
    expect(svc.getSnapshot().state).toBe('error');
    await svc.skipToTrack(0, 30); // a later chapter pick waits for the play button
    const plays = a.plays;
    a.emit('loadedmetadata');
    expect(a.plays).toBe(plays);
    expect(a.paused).toBe(true);
  });
});

describe('WebPlaybackService autoplay policy', () => {
  const realAudio = (globalThis as { Audio?: unknown }).Audio;
  let svc: PlaybackService;
  const direct: PlaybackTrack[] = [{ id: '2:x', url: 'https://s/x.mp3?token=k', title: 'B' }];
  const refuse = (name: string) =>
    jest
      .spyOn(FakeAudio.prototype, 'play')
      .mockRejectedValueOnce(Object.assign(new Error('refused'), { name }));

  beforeEach(() => {
    FakeAudio.all = [];
    (globalThis as { Audio?: unknown }).Audio = FakeAudio;
    svc = createPlaybackService();
  });
  afterEach(() => {
    (globalThis as { Audio?: unknown }).Audio = realAudio;
    jest.restoreAllMocks();
  });

  it('reports a NotAllowedError (no user gesture yet) as AutoplayBlockedError, paused', async () => {
    await svc.load(direct, 0, 70);
    refuse('NotAllowedError');
    await expect(svc.play()).rejects.toBeInstanceOf(AutoplayBlockedError);
    expect(svc.getSnapshot().state).toBe('paused');
  });

  it('does the same for a transcoded track', async () => {
    await svc.load(transcodedTracks, 0, 0);
    refuse('NotAllowedError');
    await expect(svc.play()).rejects.toBeInstanceOf(AutoplayBlockedError);
    expect(svc.getSnapshot().state).toBe('paused');
  });

  it('passes any other play() failure through untouched', async () => {
    await svc.load(direct, 0, 0);
    refuse('NotSupportedError');
    await expect(svc.play()).rejects.toMatchObject({ name: 'NotSupportedError' });
    expect(svc.getSnapshot().state).not.toBe('paused');
  });
});

describe('sourceFor', () => {
  it('is the track url at offset 0 for a direct stream', () => {
    expect(sourceFor({ id: 'x', url: 'u?a=1', title: 'T' }, 40)).toEqual({
      url: 'u?a=1',
      offset: 0,
    });
  });

  it('starts a transcoded stream at the clamped position, short of the very end', () => {
    const track = { id: 'x', url: 'u?transcode=1', title: 'T', duration: 100, transcoded: true };
    expect(sourceFor(track, 40)).toEqual({ url: 'u?transcode=1&t=40', offset: 40 });
    expect(sourceFor(track, 100)).toEqual({ url: 'u?transcode=1&t=99', offset: 99 });
    expect(sourceFor(track, 400)).toEqual({ url: 'u?transcode=1&t=99', offset: 99 });
  });
});

describe('WebPlaybackService Media Session (transcoded tracks)', () => {
  const realAudio = (globalThis as { Audio?: unknown }).Audio;
  const g = globalThis as unknown as { MediaMetadata?: unknown };
  const realMetadata = g.MediaMetadata;
  const handlers = new Map<string, unknown>();
  const setPositionState = jest.fn();

  beforeEach(() => {
    FakeAudio.all = [];
    handlers.clear();
    setPositionState.mockReset();
    (globalThis as { Audio?: unknown }).Audio = FakeAudio;
    g.MediaMetadata = class {
      constructor(public init: unknown) {}
    };
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: {
        metadata: null,
        setActionHandler: (name: string, fn: unknown) => handlers.set(name, fn),
        setPositionState,
      },
    });
  });
  afterEach(() => {
    (globalThis as { Audio?: unknown }).Audio = realAudio;
    g.MediaMetadata = realMetadata;
    delete (navigator as { mediaSession?: unknown }).mediaSession;
  });

  it('reports the track-absolute position and known duration, and routes the scrubber', async () => {
    const svc = createPlaybackService();
    await svc.load(transcodedTracks, 0, 250);
    el().currentTime = 4;
    el().emit('timeupdate');
    expect(setPositionState).toHaveBeenLastCalledWith({
      duration: 1000,
      playbackRate: 1,
      position: 254,
    });
    // The OS scrubber seeks through the engine (a re-request), not the element.
    const seekto = handlers.get('seekto') as (d: { seekTime?: number }) => void;
    seekto({ seekTime: 700 });
    expect(el().src).toBe(`${STREAM}&t=700`);
  });

  it('sends the OS seeks through the store when it listens', async () => {
    const svc = createPlaybackService();
    const storeSeek = jest.fn();
    svc.onRemoteSeek!(storeSeek);
    await svc.configure({
      autoRewindMax: 0,
      jumpForward: 30,
      jumpBackward: 15,
      smartSpeed: false,
      voiceBoost: false,
    });
    await svc.load(transcodedTracks, 0, 250);
    const src = el().src;
    (handlers.get('seekto') as (d: { seekTime?: number }) => void)({ seekTime: 20 });
    (handlers.get('seekbackward') as () => void)();
    (handlers.get('seekforward') as () => void)();
    // The store's seek lowers the resume floor and saves; the engine is not seeked behind
    // its back.
    expect(storeSeek.mock.calls).toEqual([[20], [235], [280]]);
    expect(el().src).toBe(src);
  });

  it('hands the position back to the browser for a direct stream', async () => {
    const svc = createPlaybackService();
    await svc.load(transcodedTracks, 0, 0);
    setPositionState.mockClear();
    await svc.load([{ id: 'd', url: 'https://s/d.mp3', title: 'D' }], 0, 0);
    expect(setPositionState).toHaveBeenCalledWith(); // cleared once
    expect(handlers.get('seekto')).toBeNull();
    setPositionState.mockClear();
    el().emit('timeupdate');
    expect(setPositionState).not.toHaveBeenCalled(); // then left alone
  });
});

// --- Voice Boost over a fake Web Audio graph ------------------------------------------
class FakeNode {
  targets: FakeNode[] = [];
  disconnects = 0;
  connect(n: FakeNode) {
    this.targets.push(n);
    return n;
  }
  disconnect() {
    this.disconnects++;
    this.targets = [];
  }
}
class FakeCompressor extends FakeNode {
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
}
class FakeGain extends FakeNode {
  gain = { value: 1 };
}
class FakeAudioContext {
  static all: FakeAudioContext[] = [];
  /** What the next `resume()` does: run (a gesture allowed it) or stay suspended. */
  static resumeRuns = true;
  state = 'suspended';
  destination = new FakeNode();
  compressors: FakeCompressor[] = [];
  /** The first compressor made: Voice Boost's (the second is its limiter). */
  get compressor(): FakeCompressor | null {
    return this.compressors[0] ?? null;
  }
  gains: FakeGain[] = [];
  sources = new Map<unknown, FakeNode>();
  resumes = 0;
  private listeners: (() => void)[] = [];
  constructor() {
    FakeAudioContext.all.push(this);
  }
  createDynamicsCompressor() {
    const node = new FakeCompressor();
    this.compressors.push(node);
    return node;
  }
  createGain() {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }
  createMediaElementSource(el: unknown) {
    if (this.sources.has(el)) throw new Error('InvalidStateError: already has a source');
    const node = new FakeNode();
    this.sources.set(el, node);
    return node;
  }
  addEventListener(_type: string, fn: () => void) {
    this.listeners.push(fn);
  }
  resume() {
    this.resumes++;
    if (FakeAudioContext.resumeRuns) this.run();
    return Promise.resolve();
  }
  /** The browser lets it run (a later gesture). */
  run() {
    this.state = 'running';
    for (const fn of this.listeners) fn();
  }
}

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

describe('WebPlaybackService Voice Boost (Web Audio)', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    Audio: g.Audio,
    AudioContext: g.AudioContext,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    location: Object.getOwnPropertyDescriptor(globalThis, 'location'),
  };
  let svc: PlaybackService;
  const config = (voiceBoost: boolean): PlaybackConfig => ({
    autoRewindMax: 0,
    jumpForward: 30,
    jumpBackward: 15,
    smartSpeed: false,
    voiceBoost,
  });
  const ctx = () => FakeAudioContext.all[0];
  /** Where the element's source node sends its sound, by name. */
  const routeOf = (a: FakeAudio) => {
    const source = ctx()?.sources.get(a);
    if (!source) return 'element';
    const [target] = source.targets;
    return target === ctx().compressor
      ? 'compressor'
      : target === ctx().destination
        ? 'destination'
        : 'nowhere';
  };
  function browser(userAgent: string) {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent }, configurable: true });
  }

  beforeEach(async () => {
    FakeAudio.all = [];
    FakeAudioContext.all = [];
    FakeAudioContext.resumeRuns = true;
    g.Audio = FakeAudio;
    g.AudioContext = FakeAudioContext;
    browser(CHROME);
    Object.defineProperty(globalThis, 'location', {
      value: { href: 'https://s/web/player', origin: 'https://s' },
      configurable: true,
    });
    svc = createPlaybackService();
  });
  afterEach(() => {
    g.Audio = saved.Audio;
    g.AudioContext = saved.AudioContext;
    for (const key of ['navigator', 'location'] as const) {
      const d = saved[key];
      if (d) Object.defineProperty(globalThis, key, d);
      else delete g[key];
    }
  });

  it('makes nothing at set-up, even with the setting on: only a gesture may', async () => {
    await svc.configure(config(true)); // the store's set-up call
    await svc.load(directTracks, 0, 0);
    expect(FakeAudioContext.all).toHaveLength(0);
    expect(routeOf(el())).toBe('element');
  });

  it('builds the graph on the first play tap with the setting on, and routes the book through it', async () => {
    await svc.configure(config(true));
    await svc.load(directTracks, 0, 0);
    await svc.play();
    expect(FakeAudioContext.all).toHaveLength(1);
    expect(ctx().resumes).toBe(1);
    expect(ctx().compressor).toMatchObject({
      threshold: { value: VOICE_BOOST_COMPRESSOR.threshold },
      knee: { value: VOICE_BOOST_COMPRESSOR.knee },
      ratio: { value: VOICE_BOOST_COMPRESSOR.ratio },
      attack: { value: VOICE_BOOST_COMPRESSOR.attack },
      release: { value: VOICE_BOOST_COMPRESSOR.release },
    });
    // compressor -> trim -> limiter -> destination
    const [trim] = ctx().gains;
    const limiter = ctx().compressors[1];
    expect(ctx().compressors).toHaveLength(2);
    expect(ctx().compressor!.targets).toEqual([trim]);
    expect(trim.targets).toEqual([limiter]);
    expect(trim.gain.value).toBeCloseTo(10 ** (VOICE_BOOST_TRIM_DB / 20), 6);
    expect(limiter).toMatchObject({
      threshold: { value: VOICE_BOOST_LIMITER.threshold },
      knee: { value: VOICE_BOOST_LIMITER.knee },
      ratio: { value: VOICE_BOOST_LIMITER.ratio },
      attack: { value: VOICE_BOOST_LIMITER.attack },
      release: { value: VOICE_BOOST_LIMITER.release },
    });
    expect(limiter.targets).toEqual([ctx().destination]);
    expect(routeOf(el())).toBe('compressor');
  });

  it('builds it on the switch (a gesture), and a later play makes no second one', async () => {
    await svc.configure(config(false));
    await svc.load(directTracks, 0, 0);
    await svc.configure(config(true)); // the listener's switch
    expect(FakeAudioContext.all).toHaveLength(1);
    expect(routeOf(el())).toBe('compressor');
    await svc.play();
    expect(FakeAudioContext.all).toHaveLength(1);
  });

  it('switching off reconnects the source to the destination, and never tears the graph down', async () => {
    await svc.configure(config(true));
    await svc.load(directTracks, 0, 0);
    await svc.play();
    const a = el();
    await svc.configure(config(false));
    expect(routeOf(a)).toBe('destination');
    await svc.configure(config(true));
    expect(routeOf(a)).toBe('compressor');
    expect(FakeAudioContext.all).toHaveLength(1);
    expect(ctx().sources.size).toBe(1); // one source for the element's whole life
  });

  it('leaves the wiring alone when another setting changes (no glitch mid-book)', async () => {
    await svc.configure(config(true));
    await svc.load(directTracks, 0, 0);
    await svc.play();
    const source = ctx().sources.get(el())!;
    const before = source.disconnects;
    await svc.configure({ ...config(true), jumpForward: 45 });
    expect(source.disconnects).toBe(before);
    expect(routeOf(el())).toBe('compressor');
  });

  it('never makes a graph while the boost is off', async () => {
    await svc.configure(config(false));
    await svc.load(directTracks, 0, 0);
    await svc.play();
    expect(FakeAudioContext.all).toHaveLength(0);
  });

  it('waits for a running context before routing (a suspended one would silence the book)', async () => {
    FakeAudioContext.resumeRuns = false;
    await svc.configure(config(true));
    await svc.load(directTracks, 0, 0);
    await svc.play();
    expect(routeOf(el())).toBe('element');
    ctx().run();
    expect(routeOf(el())).toBe('compressor');
  });

  it('keeps one source per element: a next file reuses it, the swapped-in element gets its own', async () => {
    jest.useFakeTimers();
    try {
      await svc.configure(config(true));
      await svc.load(directTracks, 0, 0);
      await svc.play();
      const first = el();
      await svc.skipToTrack(1, 0); // same element, new src
      expect(el()).toBe(first);
      expect(ctx().sources.size).toBe(1);
      expect(routeOf(first)).toBe('compressor');

      const local: PlaybackTrack[] = directTracks.map((t, i) => ({
        ...t,
        url: `https://s/local/${i}.mp3`,
      }));
      const swap = svc.swapTo!(local, 1, 0);
      const pending = el();
      pending.emit('loadedmetadata');
      pending.readyState = 4;
      pending.emit('canplay');
      expect(await swap).toBe(true);
      expect(ctx().sources.size).toBe(2);
      expect(routeOf(pending)).toBe('compressor');
      expect(ctx().sources.get(first)!.targets).toEqual([]); // the old one is let go
    } finally {
      jest.useRealTimers();
    }
  });

  it("plays another server's stream unboosted, on a fresh element, never through the graph", async () => {
    await svc.configure(config(true));
    await svc.load(directTracks, 0, 0);
    await svc.play();
    const routed = el();
    expect(routeOf(routed)).toBe('compressor');
    const foreign: PlaybackTrack[] = [{ id: 'x', url: 'https://other/stream?path=x', title: 'X' }];
    await svc.load(foreign, 0, 0);
    const fresh = el();
    expect(fresh).not.toBe(routed);
    expect(fresh.src).toBe('https://other/stream?path=x');
    expect(routeOf(fresh)).toBe('element');
    expect(routed.src).toBe('');
  });

  it('never in Safari', async () => {
    browser(SAFARI);
    await svc.configure(config(false));
    await svc.load(directTracks, 0, 0);
    await svc.configure(config(true));
    await svc.play();
    expect(FakeAudioContext.all).toHaveLength(0);
  });
});

// --- The web Voice Boost's level, from the browser compressor's own curve ----------------
/**
 * `DynamicsCompressorNode`'s static curve with its automatic make-up gain, as browsers compute
 * it (Web Audio spec "DynamicsCompressorNode" processing; Chromium's DynamicsCompressorKernel,
 * which Firefox shares): linear below the threshold, an exponential knee from the threshold to
 * threshold + knee whose slope there meets 1/ratio, then the ratio; the make-up gain is
 * `(1 / curve(1.0))^0.6`. Maps a steady input level (dBFS) to the output level.
 */
function webCompressor(c: { threshold: number; knee: number; ratio: number }) {
  const toDb = (x: number) => 20 * Math.log10(x);
  const toLin = (d: number) => 10 ** (d / 20);
  const lt = toLin(c.threshold);
  const kneeCurve = (x: number, k: number) => (x < lt ? x : lt + (1 - Math.exp(-k * (x - lt))) / k);
  const slopeAt = (x: number, k: number) => {
    const x2 = x * 1.001;
    return (toDb(kneeCurve(x2, k)) - toDb(kneeCurve(x, k))) / (toDb(x2) - toDb(x));
  };
  const kneeEndDb = c.threshold + c.knee;
  const kneeEnd = toLin(kneeEndDb);
  let [minK, maxK, k] = [0.1, 10000, 5];
  for (let i = 0; i < 15; i++) {
    if (slopeAt(kneeEnd, k) < 1 / c.ratio) maxK = k;
    else minK = k;
    k = Math.sqrt(minK * maxK);
  }
  const yKneeEndDb = toDb(kneeCurve(kneeEnd, k));
  const curve = (x: number) =>
    x < kneeEnd ? kneeCurve(x, k) : toLin(yKneeEndDb + (toDb(x) - kneeEndDb) / c.ratio);
  const makeupDb = 0.6 * -toDb(curve(1));
  return (levelDb: number) => toDb(curve(toLin(levelDb))) + makeupDb;
}

/** The native boost's static lift (VoiceBoostProcessor / VoiceBoostTap): -20 dBFS, 3:1, a
 * 6 dB knee centred on the threshold, +12 dB make-up. */
function nativeLiftDb(levelDb: number): number {
  const over = levelDb + 20;
  const cut =
    2 * over < -6
      ? 0
      : 2 * Math.abs(over) <= 6
        ? ((1 / 3 - 1) * (over + 3) ** 2) / 12
        : (1 / 3 - 1) * over;
  return cut + 12;
}

describe('the web Voice Boost level', () => {
  const compressor = webCompressor(VOICE_BOOST_COMPRESSOR);
  const limiter = webCompressor(VOICE_BOOST_LIMITER);
  /** The chain's output level for a steady input level. */
  const out = (levelDb: number) => limiter(compressor(levelDb) + VOICE_BOOST_TRIM_DB);

  it('lifts narration like the native boost (+8 dB for -14 dBFS peaks), within 0.5 dB above the knee', () => {
    expect(out(-14) + 14).toBeCloseTo(8, 0);
    for (const level of [-14, -12, -10, -8, -6, -4]) {
      expect(Math.abs(out(level) - level - nativeLiftDb(level))).toBeLessThan(0.5);
    }
  });

  it('lifts quiet speech by about 10 dB (the native boost: 12)', () => {
    expect(out(-40) + 40).toBeGreaterThan(9.5);
    expect(out(-40) + 40).toBeLessThan(12.5);
  });

  it('keeps a full-scale input under -1 dBFS (the limiter, with its own make-up)', () => {
    expect(out(0)).toBeLessThan(-1);
    expect(out(0)).toBeGreaterThan(-2);
  });
});
