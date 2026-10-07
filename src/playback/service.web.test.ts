import { createPlaybackService, isSwapReady, routePickerKind, sourceFor } from './service.web';
import type { PlaybackService, PlaybackTrack } from './types';

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
// (which is what a transcoded seek, a new src each time, runs into).
class FakeAudio {
  static all: FakeAudio[] = [];
  src = '';
  preload = '';
  volume = 1;
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
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
    this.playbackRate = this.defaultPlaybackRate;
  }
  play() {
    this.plays++;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.emit('pause');
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

  it('clamps a seek into the known duration', async () => {
    await startPlaying(0);
    await svc.seekTo(5000);
    expect(el().src).toBe(`${STREAM}&t=1000`);
    await svc.seekTo(-20);
    expect(el().src).toBe(STREAM);
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
    await svc.configure({ autoRewindMax: 30, jumpForward: 30, jumpBackward: 15 });
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

describe('sourceFor', () => {
  it('is the track url at offset 0 for a direct stream', () => {
    expect(sourceFor({ id: 'x', url: 'u?a=1', title: 'T' }, 40)).toEqual({
      url: 'u?a=1',
      offset: 0,
    });
  });

  it('starts a transcoded stream at the clamped position', () => {
    const track = { id: 'x', url: 'u?transcode=1', title: 'T', duration: 100, transcoded: true };
    expect(sourceFor(track, 40)).toEqual({ url: 'u?transcode=1&t=40', offset: 40 });
    expect(sourceFor(track, 400)).toEqual({ url: 'u?transcode=1&t=100', offset: 100 });
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
