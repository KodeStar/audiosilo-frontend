import { INITIAL_SNAPSHOT, type PlaybackService, type PlaybackSnapshot } from '@/playback/types';

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
jest.mock('@/lib/bootstrap', () => ({ bootstrapPlayback: async () => {} }));
const mockAdopt = jest.fn(async () => false);
const mockPlayer = { nowPlaying: null as unknown, adoptLoaded: mockAdopt };
const mockInitialize = jest.fn(async () => {
  if (!currentRouter()) routed(localEngine());
});
jest.mock('@/playback/store', () => ({
  initializePlayback: () => mockInitialize(),
  usePlayer: { getState: () => mockPlayer },
}));
jest.mock('@/stores/session', () => ({ onConnectionRemoved: () => () => {} }));

/* eslint-disable import/first */
import { CastBlockedError } from './cast-prepare';
import { endCastForCar, startCastSync } from './cast-session';
import { useCast } from './cast-state';
import { currentRouter, forgetRouter, routed } from './routed-service';
import type { CastDriver, CastRemote, CastSessionEvent } from './types';
/* eslint-enable import/first */

function localEngine(): PlaybackService {
  const snap: PlaybackSnapshot = { ...INITIAL_SNAPSHOT };
  return {
    setup: async () => {},
    configure: async () => {},
    load: async () => {},
    play: async () => {},
    pause: async () => {},
    seekTo: async () => {},
    skipToTrack: async () => {},
    setRate: async () => {},
    setVolume: async () => {},
    reset: async () => {},
    getSnapshot: () => snap,
    subscribe: () => () => {},
  };
}

function remote(): CastRemote {
  return {
    load: jest.fn(async () => {}),
    play: jest.fn(async () => {}),
    pause: jest.fn(async () => {}),
    seek: jest.fn(async () => {}),
    setRate: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    readStatus: jest.fn(async () => null),
    onStatus: () => () => {},
    onProgress: () => () => {},
  };
}

function fakeDriver(supported = true) {
  let handler: ((e: CastSessionEvent) => void) | null = null;
  const driver: CastDriver & { fire(e: CastSessionEvent): void } = {
    supported: async () => supported,
    init: jest.fn(async () => true),
    subscribe: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    current: jest.fn(async () => null),
    endSession: jest.fn(async () => {}),
    fire: (e) => handler?.(e),
  };
  return driver;
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('startCastSync', () => {
  beforeEach(() => {
    forgetRouter();
    useCast.setState({ supported: null, status: 'off', deviceName: null });
    mockToast.mockClear();
    mockAdopt.mockClear();
    mockInitialize.mockClear();
    mockPlayer.nowPlaying = null;
  });

  it('marks a device that cannot cast and listens to nothing', async () => {
    const driver = fakeDriver(false);
    const stop = startCastSync({ driver });
    await flush();
    expect(useCast.getState().supported).toBe(false);
    expect(driver.init).not.toHaveBeenCalled();
    stop();
  });

  it('switches the route to the receiver on a started session and back when it ends', async () => {
    const router = routed(localEngine());
    const driver = fakeDriver();
    const stop = startCastSync({ driver, prepare: async () => ({ items: [] }) });
    await flush();
    expect(useCast.getState().supported).toBe(true);
    driver.fire({ type: 'starting' });
    expect(useCast.getState().status).toBe('connecting');
    driver.fire({ type: 'started', remote: remote(), deviceName: 'Living room' });
    await flush();
    expect(useCast.getState()).toMatchObject({ status: 'connected', deviceName: 'Living room' });
    expect(router.castRoute()).not.toBeNull();
    driver.fire({ type: 'ended' });
    await flush();
    expect(router.castRoute()).toBeNull();
    expect(useCast.getState().status).toBe('off');
    stop();
  });

  it('becomes the route once the store creates its engine, for a session that came first', async () => {
    const driver = fakeDriver();
    const stop = startCastSync({ driver, prepare: async () => ({ items: [] }) });
    await flush();
    driver.fire({ type: 'started', remote: remote() });
    await flush();
    const router = routed(localEngine()); // the first play
    await flush();
    expect(router.castRoute()).not.toBeNull();
    stop();
  });

  it('a session that ended before the stores were ready never becomes the route', async () => {
    const driver = fakeDriver();
    const stop = startCastSync({ driver, prepare: async () => ({ items: [] }) });
    await flush();
    driver.fire({ type: 'started', remote: remote() });
    driver.fire({ type: 'ended' });
    await flush();
    const router = routed(localEngine());
    await flush();
    expect(router.castRoute()).toBeNull();
    stop();
  });

  it('explains a book that cannot be cast and ends the session', async () => {
    const router = routed(localEngine());
    const driver = fakeDriver();
    const stop = startCastSync({ driver });
    await flush();
    driver.fire({ type: 'started', remote: remote() });
    await flush();
    router.onCastFailed?.(new CastBlockedError('codec'));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.any(String), description: expect.any(String) }),
    );
    expect(driver.endSession).toHaveBeenCalledWith(true);
    stop();
  });

  it('picks up a session already running at launch (the app was relaunched mid-cast)', async () => {
    const router = routed(localEngine());
    const driver = fakeDriver();
    const rx = remote();
    (driver.current as jest.Mock).mockResolvedValue({ remote: rx, deviceName: 'Kitchen' });
    (rx.readStatus as jest.Mock).mockResolvedValue({
      playerState: 'playing',
      position: 321,
      rate: 1.5,
      customIndex: 1,
      book: { connectionId: 'srv.1', libraryId: 2, path: 'A/B' },
    });
    const stop = startCastSync({ driver, prepare: async () => ({ items: [] }) });
    await flush();
    expect(router.castRoute()).not.toBeNull();
    expect(mockAdopt).toHaveBeenCalledWith({
      connectionId: 'srv.1',
      libraryId: 2,
      path: 'A/B',
      trackIndex: 1,
      position: 321,
      rate: 1.5,
      playing: true,
    });
    stop();
  });

  it('finding 11: adoption adds the transcode starting offset to receiver time', async () => {
    routed(localEngine());
    const driver = fakeDriver();
    const rx = remote();
    (rx.readStatus as jest.Mock).mockResolvedValue({
      playerState: 'playing',
      position: 20,
      rate: 1,
      customIndex: 0,
      book: { connectionId: 'srv.1', libraryId: 2, path: 'B' },
      contentId: 'https://h/stream?transcode=1&t=1800',
    });
    const stop = startCastSync({ driver, prepare: async () => ({ items: [] }) });
    await flush();
    driver.fire({ type: 'resumed', remote: rx });
    await flush();
    expect(mockAdopt).toHaveBeenCalledWith(expect.objectContaining({ position: 1820 }));
    stop();
  });

  it('finding 12: a cold resumed session initializes its router and reads the receiver', async () => {
    expect(currentRouter()).toBeNull();
    const driver = fakeDriver();
    const rx = remote();
    (driver.current as jest.Mock).mockResolvedValue({ remote: rx });
    (rx.readStatus as jest.Mock).mockResolvedValue({
      playerState: 'playing',
      position: 80,
      rate: 1,
      customIndex: 0,
      book: { connectionId: 'srv.1', libraryId: 2, path: 'B' },
    });
    const stop = startCastSync({ driver, prepare: async () => ({ items: [] }) });
    await flush();
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(currentRouter()?.castRoute()).not.toBeNull();
    expect(mockAdopt).toHaveBeenCalledWith(expect.objectContaining({ position: 80 }));
    expect(rx.load).not.toHaveBeenCalled();
    expect(rx.play).not.toHaveBeenCalled();
    stop();
  });

  it('reads the receiver again when the app comes back, without a second handover', async () => {
    const router = routed(localEngine());
    const driver = fakeDriver();
    const stop = startCastSync({ driver, prepare: async () => ({ items: [] }) });
    await flush();
    driver.fire({ type: 'started', remote: remote() });
    await flush();
    const route = router.castRoute()!;
    const refresh = jest.spyOn(route, 'refresh');
    driver.fire({ type: 'suspended' });
    driver.fire({ type: 'resumed', remote: remote() });
    await flush();
    expect(router.castRoute()).toBe(route);
    expect(refresh).toHaveBeenCalled();
    stop();
  });
});

describe('endCastForCar (finding 9)', () => {
  beforeEach(() => forgetRouter());

  it("brings the receiver's place home first, then ends the session and stops the receiver", async () => {
    const router = routed(localEngine());
    const order: string[] = [];
    const cast = {
      refresh: jest.fn(async () => void order.push('read the place')),
    };
    jest.spyOn(router, 'isCasting').mockReturnValue(true);
    jest.spyOn(router, 'castRoute').mockReturnValue(cast as never);
    jest.spyOn(router, 'endCast').mockImplementation(async () => void order.push('hand back'));
    const driver = fakeDriver();
    (driver.endSession as jest.Mock).mockImplementation(async (stop: boolean) => {
      order.push(`end session (stop ${stop})`);
    });
    await expect(endCastForCar(driver)).resolves.toBe(true);
    expect(order).toEqual(['read the place', 'hand back', 'end session (stop true)']);
  });

  it('does nothing when nothing is cast', async () => {
    routed(localEngine());
    const driver = fakeDriver();
    await expect(endCastForCar(driver)).resolves.toBe(false);
    expect(driver.endSession).not.toHaveBeenCalled();
  });
});
