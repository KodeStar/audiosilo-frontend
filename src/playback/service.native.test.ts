import type { PlaybackSnapshot } from './types';

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
  it('takes a remote move into its snapshot BEFORE telling the store', async () => {
    const svc = await setUp();
    let seen: PlaybackSnapshot | null = null;
    const handler = jest.fn(() => {
      seen = svc.getSnapshot();
    });
    svc.onRemoteMove!(handler);
    send('onRemoteMove', { trackIndex: 1, position: 42 });
    expect(handler).toHaveBeenCalledWith(1, 42);
    expect(seen).toMatchObject({ trackIndex: 1, position: 42 });
  });

  it('passes the OS speed on, in the snapshot too', async () => {
    const svc = await setUp();
    const handler = jest.fn();
    svc.onRateChange!(handler);
    send('onRateChange', { rate: 1.5 });
    expect(handler).toHaveBeenCalledWith(1.5);
    expect(svc.getSnapshot().rate).toBe(1.5);
  });

  it('passes a remote bookmark press on, without moving', async () => {
    const svc = await setUp();
    const handler = jest.fn();
    svc.onRemoteBookmark!(handler);
    send('onRemoteBookmark', { trackIndex: 0, position: 9 });
    expect(handler).toHaveBeenCalledWith(0, 9);
    expect(svc.getSnapshot().position).toBe(0);
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
