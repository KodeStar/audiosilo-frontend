// The native module, faked: its events are captured by name so a test can send them, and
// `getLoadedBook` is present or absent to stand for a Phase 6 binary or an older one.
type Handler = (event: Record<string, unknown>) => void;
const mockHandlers = new Map<string, Handler>();
const mockModule: Record<string, unknown> = {};
function resetModule(phase6: boolean) {
  mockHandlers.clear();
  for (const k of Object.keys(mockModule)) delete mockModule[k];
  Object.assign(mockModule, {
    addListener: jest.fn((name: string, fn: Handler) => {
      mockHandlers.set(name, fn);
      return { remove: jest.fn() };
    }),
    setup: jest.fn(async () => {}),
    setConfig: jest.fn(async () => {}),
    load: jest.fn(async () => {}),
    ...(phase6 ? { getLoadedBook: jest.fn(async () => null) } : {}),
  });
}
// A getter: the factory runs (hoisted) before `mockModule` is initialised.
jest.mock('../../modules/audiosilo-player', () => ({
  __esModule: true,
  get default() {
    return mockModule;
  },
}));

/* eslint-disable import/first */
import { Platform } from 'react-native';

import { createPlaybackService } from './service.native';
/* eslint-enable import/first */

const send = (name: string, event: Record<string, unknown>) => mockHandlers.get(name)!(event);
const tracks = [
  { id: 'a', url: 'https://s/a.mp3', title: 'A', duration: 100 },
  { id: 'b', url: 'https://s/b.mp3', title: 'A', duration: 200 },
];
const book = { connectionId: 'c1', libraryId: 2, path: 'A' };

async function setUp(phase6 = true) {
  resetModule(phase6);
  const svc = createPlaybackService();
  await svc.setup();
  return svc;
}

describe('the native engine, Phase 6 events', () => {
  // fe#211: told after its landed place, the store's save, cut or keep could end the
  // listening span at the landed place first, and the move then read as one to nowhere.
  it('tells the store of a remote move before its listeners take the landed place', async () => {
    const svc = await setUp();
    const heard: number[] = [];
    svc.subscribe((s) => heard.push(s.position));
    let heardWhenMoved: number[] = [];
    const handler = jest.fn(() => {
      heardWhenMoved = [...heard];
    });
    svc.onRemoteMove!(handler);
    send('onProgress', { position: 10, duration: 100 });
    send('onRemoteMove', { trackIndex: 1, position: 42 });
    expect(handler).toHaveBeenCalledWith(1, 42);
    expect(heardWhenMoved).toEqual([10]);
    expect(heard).toEqual([10, 42]);
    expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 42 });
  });

  it('passes the OS speed on, in the snapshot too', async () => {
    const svc = await setUp();
    const handler = jest.fn();
    svc.onRateChange!(handler);
    send('onRateChange', { rate: 1.5 });
    expect(handler).toHaveBeenCalledWith(1.5);
    expect(svc.getSnapshot().rate).toBe(1.5);
  });

  it("reads Smart Speed's total from progress ticks, and nothing from an older binary's", async () => {
    const svc = await setUp();
    const handler = jest.fn();
    svc.onSilenceSaved!(handler);
    send('onProgress', { position: 5, duration: 100, silenceSaved: 3.5 });
    send('onProgress', { position: 6, duration: 100 }); // no field: an older binary
    expect(handler.mock.calls).toEqual([[3.5]]);
    expect(svc.getSnapshot().position).toBe(6);
  });

  // fe#158: Android ticks while it buffers on its way to playing, the stall watchdog's
  // heartbeat with the screen off (the store checks its deadline on every snapshot).
  it('hands every tick while loading to its listeners, never held', async () => {
    const svc = await setUp();
    const heard: string[] = [];
    svc.subscribe((s) => heard.push(`${s.state}@${s.position}`));
    send('onState', { state: 'loading' });
    send('onProgress', { position: 12, duration: 100 });
    send('onProgress', { position: 12, duration: 100 });
    expect(heard).toEqual(['loading@0', 'loading@12', 'loading@12']);
  });

  // fe#157: a car or headset play after an error reaches the store as one, before its state.
  it('tells the store when Android turns to wanting to play, before the state', async () => {
    const svc = await setUp();
    const heard: string[] = [];
    svc.subscribe((s) => heard.push(s.state));
    let heardWhenAsked: string[] | null = null;
    const handler = jest.fn(() => {
      heardWhenAsked = [...heard];
    });
    svc.onPlayAsked!(handler);
    send('onState', { state: 'error', playWhenReady: false });
    send('onState', { state: 'loading', playWhenReady: false });
    expect(handler).not.toHaveBeenCalled();
    send('onState', { state: 'loading', playWhenReady: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(heardWhenAsked).toEqual(['error', 'loading']);
    // Still wanting to: no new ask.
    send('onState', { state: 'playing', playWhenReady: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('tells no ask without a playWhenReady to compare (iOS, an older binary, the first state)', async () => {
    const svc = await setUp();
    const handler = jest.fn();
    svc.onPlayAsked!(handler);
    send('onState', { state: 'loading', playWhenReady: true });
    send('onState', { state: 'paused' });
    send('onState', { state: 'playing' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("the native engine's load", () => {
  it('names the book to a Phase 6 binary', async () => {
    const svc = await setUp(true);
    await svc.load(tracks, 1, 10, [], book);
    expect((mockModule.load as jest.Mock).mock.calls[0]).toHaveLength(5);
    expect((mockModule.load as jest.Mock).mock.calls[0][4]).toEqual(book);
  });

  it('keeps to four arguments on an older binary (more would throw there)', async () => {
    const svc = await setUp(false);
    await svc.load(tracks, 1, 10, [], book);
    expect((mockModule.load as jest.Mock).mock.calls[0]).toHaveLength(4);
  });

  it('sends the effects with the other tunables', async () => {
    const svc = await setUp();
    const config = {
      autoRewindMax: 5,
      jumpForward: 30,
      jumpBackward: 15,
      smartSpeed: true,
      voiceBoost: false,
    };
    await svc.configure(config);
    expect(mockModule.setConfig).toHaveBeenCalledWith(config);
  });
});

// fe#211: a lock-screen, headset or car move lands in a progress tick before its onRemoteMove
// (iOS sends both together, Android the move up to 300 ms later).
describe('a progress tick that jumped while playing', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Playing file 0 (100 s long): ticks at `from` and a second on. */
  async function playing(from = 10) {
    const svc = await setUp();
    const heard: number[] = [];
    svc.subscribe((s) => heard.push(s.position));
    send('onState', { state: 'playing' });
    send('onProgress', { position: from, duration: 100 });
    jest.advanceTimersByTime(1_000);
    send('onProgress', { position: from + 1, duration: 100 });
    return { svc, heard: () => heard.slice(2) };
  }

  /** `playing`, its listeners heard from then on as [file, place]. */
  async function heardPlaces(from?: number) {
    const { svc } = await playing(from);
    const places: [number, number][] = [];
    svc.subscribe((s) => places.push([s.trackIndex, s.position]));
    return { svc, places };
  }

  /** Playing up to file 0's end: its last tick at 99.8, then 300 ms on. */
  async function nearTheEnd() {
    const heard = await heardPlaces(98.8);
    jest.advanceTimersByTime(300);
    return heard;
  }

  it('waits for its move, which the store hears before the landed place', async () => {
    const { svc, heard } = await playing();
    let heardWhenMoved: number[] = [];
    svc.onRemoteMove!(() => {
      heardWhenMoved = heard();
    });
    jest.advanceTimersByTime(200);
    send('onProgress', { position: 70, duration: 100 }); // a 60 s skip landed
    expect(heard()).toEqual([11]);
    expect(svc.getSnapshot().position).toBe(11);
    jest.advanceTimersByTime(300);
    send('onRemoteMove', { trackIndex: 0, position: 70 });
    expect(heardWhenMoved).toEqual([11]);
    expect(heard()).toEqual([11, 70]);
    // Its wait is over: nothing more comes of the held tick.
    jest.advanceTimersByTime(1_000);
    expect(heard()).toEqual([11, 70]);
  });

  it('holds a move back too', async () => {
    const { heard } = await playing();
    jest.advanceTimersByTime(1_000);
    send('onProgress', { position: 2, duration: 100 });
    expect(heard()).toEqual([11]);
    send('onRemoteMove', { trackIndex: 0, position: 2 });
    expect(heard()).toEqual([11, 2]);
  });

  // A move into another file lands in a tick with that file's length, held for the move.
  it('keeps the held tick’s length for the move that replaces it', async () => {
    const { svc } = await playing();
    send('onProgress', { position: 3, duration: 250 });
    expect(svc.getSnapshot()).toMatchObject({ position: 11, duration: 100 });
    send('onRemoteMove', { trackIndex: 1, position: 3 });
    expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 3, duration: 250 });
  });

  it('gives its listeners the landed place even when the move’s handler throws', async () => {
    const { svc, heard } = await playing();
    svc.onRemoteMove!(() => {
      throw new Error('handler failed');
    });
    expect(() => send('onRemoteMove', { trackIndex: 0, position: 70 })).toThrow('handler failed');
    expect(heard()).toEqual([11, 70]);
  });

  it('takes a move the engine made by itself once the wait is over, the newest tick', async () => {
    const { heard } = await playing();
    send('onProgress', { position: 70, duration: 100 });
    jest.advanceTimersByTime(250);
    send('onProgress', { position: 70.25, duration: 100 });
    expect(heard()).toEqual([11]);
    jest.advanceTimersByTime(350);
    expect(heard()).toEqual([11, 70.25]);
    // Playing on from there is taken at once.
    jest.advanceTimersByTime(1_000);
    send('onProgress', { position: 71.3, duration: 100 });
    expect(heard()).toEqual([11, 70.25, 71.3]);
  });

  // A pause inside the wait: the tick stays held (taken as playing stops, its place would end
  // the span there), so the store's save at the pause has the place before the jump.
  it('tells a held tick no move replaced, taken after playing stopped', async () => {
    const { svc, heard } = await playing();
    const landed = jest.fn(() => expect(svc.getSnapshot().position).toBe(70));
    svc.onLanded!(landed);
    send('onProgress', { position: 70, duration: 100 });
    jest.advanceTimersByTime(200);
    send('onState', { state: 'paused' });
    expect(svc.getSnapshot()).toMatchObject({ state: 'paused', position: 11 });
    expect(landed).not.toHaveBeenCalled();
    jest.advanceTimersByTime(400);
    expect(heard()).toEqual([11, 11, 70]);
    expect(landed).toHaveBeenCalledTimes(1);
  });

  it('tells nothing of a held tick taken while playing, nor of one its move replaced', async () => {
    const { svc } = await playing();
    const landed = jest.fn();
    svc.onLanded!(landed);
    send('onProgress', { position: 70, duration: 100 });
    jest.advanceTimersByTime(600);
    expect(svc.getSnapshot().position).toBe(70);
    jest.advanceTimersByTime(1_000);
    send('onProgress', { position: 20, duration: 100 });
    send('onState', { state: 'paused' });
    send('onRemoteMove', { trackIndex: 0, position: 20 });
    jest.advanceTimersByTime(1_000);
    expect(svc.getSnapshot()).toMatchObject({ state: 'paused', position: 20 });
    expect(landed).not.toHaveBeenCalled();
  });

  it('ends a hold whose timer never fired at the next tick (Android pauses JS timers)', async () => {
    const { heard } = await playing();
    send('onProgress', { position: 70, duration: 100 });
    expect(heard()).toEqual([11]);
    // The clock moves on, but no timer runs.
    jest.setSystemTime(Date.now() + 1_000);
    send('onProgress', { position: 71, duration: 100 });
    expect(heard()).toEqual([11, 70, 71]);
  });

  it('takes ticks that play on at the speed at once', async () => {
    const { svc, heard } = await playing();
    (mockModule as Record<string, unknown>).setRate = jest.fn(async () => {});
    await svc.setRate(3);
    jest.advanceTimersByTime(2_000);
    send('onProgress', { position: 17, duration: 100 }); // 6 s in 2 s at 3x
    expect(heard().at(-1)).toBe(17);
  });

  it('never holds the first tick of a play (a resume’s auto-rewind)', async () => {
    const { heard } = await playing();
    send('onState', { state: 'paused' });
    jest.advanceTimersByTime(60_000);
    send('onState', { state: 'playing' });
    send('onProgress', { position: 1, duration: 100 });
    expect(heard().at(-1)).toBe(1);
  });

  it('drops a held tick for a place the store set (its own seek)', async () => {
    const { svc, heard } = await playing();
    (mockModule as Record<string, unknown>).seekTo = jest.fn(async () => {});
    send('onProgress', { position: 40, duration: 100 });
    await svc.seekTo(40.5);
    jest.advanceTimersByTime(1_000);
    expect(heard()).toEqual([11, 40.5]);
  });

  it('takes the tick after its own seek at once, never held for a jump', async () => {
    const { svc, heard } = await playing();
    (mockModule as Record<string, unknown>).seekTo = jest.fn(async () => {});
    await svc.seekTo(80);
    send('onProgress', { position: 80.2, duration: 100 });
    expect(heard()).toEqual([11, 80, 80.2]);
  });

  it('takes a held tick before the file changes (iOS: the change comes first)', async () => {
    const { svc, heard } = await playing();
    send('onProgress', { position: 70, duration: 100 });
    send('onTrackChange', { index: 1 });
    expect(heard()).toEqual([11, 70, 0]);
    expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 0 });
  });

  it('starts the new file at 0 on iOS, where its first tick comes after the change', async () => {
    const { svc, places } = await nearTheEnd();
    send('onTrackChange', { index: 1 });
    send('onState', { state: 'paused' }); // before the new file's first tick
    expect(places).toEqual([
      [1, 0],
      [1, 0],
    ]);
    jest.advanceTimersByTime(600);
    send('onProgress', { position: 0.3, duration: 200 });
    expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 0.3, duration: 200 });
  });

  it('keeps the place on iOS when a rebuild tells the file it is already in', async () => {
    const { places } = await heardPlaces();
    send('onTrackChange', { index: 0 });
    expect(places).toEqual([[0, 11]]);
  });

  describe('on Android, where the new file’s tick comes before its change', () => {
    beforeEach(() => {
      Platform.OS = 'android';
    });
    afterEach(() => {
      Platform.OS = 'ios';
    });

    /** The new file's tick, then its change: a move into file 1, its report still to come. */
    function moveIntoFile1(position: number) {
      send('onProgress', { position, duration: 250 });
      send('onTrackChange', { index: 1 });
    }
    /** File 1's first tick (held, a jump back), then its change: a run-on from `nearTheEnd`. */
    function runOnIntoFile1() {
      send('onProgress', { position: 0.05, duration: 200 });
      send('onTrackChange', { index: 1 });
    }

    it('tells the held tick under the new file, with its move', async () => {
      const { svc, places } = await heardPlaces();
      let heardWhenMoved: [number, number][] | null = null;
      svc.onRemoteMove!(() => {
        heardWhenMoved = [...places];
      });
      moveIntoFile1(3);
      expect(places).toEqual([]);
      send('onRemoteMove', { trackIndex: 1, position: 3 });
      expect(heardWhenMoved).toEqual([]);
      expect(places).toEqual([[1, 3]]);
      expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 3, duration: 250 });
    });

    it('tells the held tick under the new file once the wait is over', async () => {
      const { places } = await heardPlaces();
      moveIntoFile1(0.2);
      jest.advanceTimersByTime(600);
      expect(places).toEqual([[1, 0.2]]);
    });

    it('keeps the place before a move with its own file when playing stops first', async () => {
      const { svc, places } = await heardPlaces();
      const landed = jest.fn();
      svc.onLanded!(landed);
      moveIntoFile1(3);
      send('onState', { state: 'paused' });
      expect(places).toEqual([[0, 11]]);
      jest.advanceTimersByTime(600);
      expect(places).toEqual([
        [0, 11],
        [1, 3],
      ]);
      expect(landed).toHaveBeenCalledTimes(1);
    });

    it('seeks in the snapshot’s file, back from the one a held move went to', async () => {
      const { svc, places } = await heardPlaces();
      const seekTo = jest.fn(async () => {});
      const skipToTrack = jest.fn(async () => {});
      Object.assign(mockModule, { seekTo, skipToTrack });
      moveIntoFile1(3);
      await svc.seekTo(40);
      expect(seekTo).not.toHaveBeenCalled();
      expect(skipToTrack).toHaveBeenCalledWith(0, 40);
      expect(places).toEqual([[0, 40]]);
      jest.advanceTimersByTime(600);
      expect(places).toEqual([[0, 40]]);
    });

    it('tells a run-on into the next file at once, its place the new file’s', async () => {
      const { svc, places } = await nearTheEnd();
      runOnIntoFile1();
      expect(places).toEqual([[1, 0.05]]);
      expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 0.05, duration: 200 });
    });

    it('saves a pause right after a run-on in the new file, never at the old one’s end', async () => {
      const { svc, places } = await nearTheEnd();
      runOnIntoFile1();
      send('onState', { state: 'paused' }); // within the hold's 600 ms
      jest.advanceTimersByTime(600);
      expect(places).toEqual([
        [1, 0.05],
        [1, 0.05],
      ]);
      expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 0.05 });
    });
  });
});
