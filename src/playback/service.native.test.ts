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
  it('passes a remote move on, its landed place in the snapshot once told', async () => {
    const svc = await setUp();
    const handler = jest.fn();
    svc.onRemoteMove!(handler);
    send('onRemoteMove', { trackIndex: 1, position: 42 });
    expect(handler).toHaveBeenCalledWith(1, 42);
    expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 42 });
  });

  // fe#211: told after its landed place, the store's save, cut or keep could end the
  // listening span at the landed place first, and the move then read as one to nowhere.
  it('tells the store of a remote move before its listeners take the landed place', async () => {
    const svc = await setUp();
    const heard: number[] = [];
    svc.subscribe((s) => heard.push(s.position));
    let heardWhenMoved: number[] = [];
    svc.onRemoteMove!(() => {
      heardWhenMoved = [...heard];
    });
    send('onProgress', { position: 10, duration: 100 });
    send('onRemoteMove', { trackIndex: 0, position: 42 });
    expect(heardWhenMoved).toEqual([10]);
    expect(heard).toEqual([10, 42]);
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

  it('takes a held tick before the file changes', async () => {
    const { svc, heard } = await playing();
    send('onProgress', { position: 70, duration: 100 });
    send('onTrackChange', { index: 1 });
    expect(heard()).toEqual([11, 70, 70]);
    expect(svc.getSnapshot()).toMatchObject({ trackIndex: 1, position: 70 });
  });
});
