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

  async function playing() {
    const svc = await setUp();
    const heard: number[] = [];
    svc.subscribe((s) => heard.push(s.position));
    send('onState', { state: 'playing' });
    send('onProgress', { position: 10, duration: 100 });
    jest.advanceTimersByTime(1_000);
    send('onProgress', { position: 11, duration: 100 });
    return { svc, heard: () => heard.slice(2) };
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
    expect(heard()).toEqual([11, 70, 70]);
    expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 70 });
  });

  describe('on Android, where the new file’s tick comes before its change', () => {
    beforeEach(() => {
      Platform.OS = 'android';
    });
    afterEach(() => {
      Platform.OS = 'ios';
    });

    async function heardPlaces() {
      const { svc } = await playing();
      const places: [number, number][] = [];
      svc.subscribe((s) => places.push([s.trackIndex, s.position]));
      return { svc, places };
    }

    it('tells the held tick under the new file, with its move', async () => {
      const { svc, places } = await heardPlaces();
      let heardWhenMoved: [number, number][] | null = null;
      svc.onRemoteMove!(() => {
        heardWhenMoved = [...places];
      });
      send('onProgress', { position: 3, duration: 250 }); // the next chapter, in file 1
      send('onTrackChange', { index: 1 });
      expect(places).toEqual([]);
      send('onRemoteMove', { trackIndex: 1, position: 3 });
      expect(heardWhenMoved).toEqual([]);
      expect(places).toEqual([[1, 3]]);
      expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 3, duration: 250 });
    });

    it('tells the held tick under the new file once the wait is over', async () => {
      const { places } = await heardPlaces();
      send('onProgress', { position: 0.2, duration: 250 }); // ran on into file 1
      send('onTrackChange', { index: 1 });
      jest.advanceTimersByTime(600);
      expect(places).toEqual([[1, 0.2]]);
    });
  });
});
