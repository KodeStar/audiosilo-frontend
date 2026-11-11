import { MutationObserver, onlineManager, QueryObserver } from '@tanstack/react-query';

// The system's network state, as expo-network reports it. Held on the mock itself: the
// modules under test subscribe as they are imported, before this file's constants exist.
type NetState = { isConnected?: boolean; isInternetReachable?: boolean | null };
type MockNetwork = { listeners: ((s: NetState) => void)[]; state: { now: NetState } };
jest.mock('expo-network', () => {
  const listeners: ((s: NetState) => void)[] = [];
  const state: { now: NetState } = { now: { isConnected: true, isInternetReachable: true } };
  return {
    getNetworkStateAsync: () => Promise.resolve(state.now),
    addNetworkStateListener: (cb: (s: NetState) => void) => {
      listeners.push(cb);
      return { remove: jest.fn() };
    },
    NetworkStateType: {},
    listeners,
    state,
  };
});

/* eslint-disable import/first */
import { fetchFailFast } from './hooks';
import { queryClient } from './provider';
/* eslint-enable import/first */

/** The system reports a network state to every listener (reachability's and ours). */
async function system(state: NetState) {
  const network = jest.requireMock<MockNetwork>('expo-network');
  network.state.now = state;
  for (const cb of [...network.listeners]) cb(state);
  await Promise.resolve();
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// fe#179 / fe#202: on iOS and Android nothing told React Query the device was offline, so
// queries never paused and the offline states only showed on the web. (The web keeps
// TanStack's own listener, the browser's `online` and `offline` events: the provider only
// replaces it off the web.)
describe("React Query's online flag in the app", () => {
  beforeAll(() => queryClient.mount());
  afterAll(() => queryClient.unmount());
  afterEach(async () => {
    await system({ isConnected: true, isInternetReachable: true });
    queryClient.clear();
  });

  it('follows the system network state (the signal useDeviceOnline shows)', async () => {
    expect(onlineManager.isOnline()).toBe(true);
    await system({ isConnected: false, isInternetReachable: false });
    expect(onlineManager.isOnline()).toBe(false);
    await system({ isConnected: true, isInternetReachable: true });
    expect(onlineManager.isOnline()).toBe(true);
  });

  it('stays online on a network with no internet: a LAN server is still asked', async () => {
    await system({ isConnected: true, isInternetReachable: false });
    expect(onlineManager.isOnline()).toBe(true);
    const ask = jest.fn(async () => 'answer');
    const observer = new QueryObserver(queryClient, { queryKey: ['lan'], queryFn: ask });
    const stop = observer.subscribe(() => undefined);
    await tick();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().data).toBe('answer');
    stop();
  });

  it('pauses a query while offline and asks it once the network is back', async () => {
    await system({ isConnected: false });
    const ask = jest.fn(async () => 'answer');
    const observer = new QueryObserver(queryClient, { queryKey: ['held'], queryFn: ask });
    const stop = observer.subscribe(() => undefined);
    await tick();
    // Held, not failed: the screens show their offline state for it (`isPaused`).
    expect(ask).not.toHaveBeenCalled();
    expect(observer.getCurrentResult()).toMatchObject({
      status: 'pending',
      fetchStatus: 'paused',
      isPaused: true,
    });

    await system({ isConnected: true });
    await tick();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult()).toMatchObject({ status: 'success', data: 'answer' });
    stop();
  });

  it('still settles a read that must not wait (fetchFailFast: the play path, the car)', async () => {
    await system({ isConnected: false });
    await expect(
      fetchFailFast({
        queryKey: ['now'],
        queryFn: async () => {
          throw new TypeError('Network request failed');
        },
      }),
    ).rejects.toThrow('Network request failed');
  });

  // Only reads wait. A write held for the network never settles (Save spins) and lives
  // only in memory: closing the app before the network is back loses it without a word.
  describe('a write (a bookmark, a note, a rating, the queue, a collection, a progress edit)', () => {
    it('is sent with no network, and fails at once with its own error', async () => {
      await system({ isConnected: false });
      const send = jest.fn(async () => {
        throw new TypeError('Network request failed');
      });
      const observer = new MutationObserver(queryClient, { mutationFn: send });
      await expect(observer.mutate()).rejects.toThrow('Network request failed');
      expect(send).toHaveBeenCalledTimes(1);
      expect(observer.getCurrentResult()).toMatchObject({ status: 'error', isPaused: false });
    });

    it('lands with no network when its server still answers', async () => {
      await system({ isConnected: false });
      const observer = new MutationObserver(queryClient, { mutationFn: async () => 'saved' });
      await expect(observer.mutate()).resolves.toBe('saved');
    });

    it('keeps the one-at-a-time order of a scope', async () => {
      await system({ isConnected: false });
      const order: string[] = [];
      // The first takes longer than the second: run side by side, the second would land
      // first.
      const write = (name: string, ticks: number) =>
        new MutationObserver(queryClient, {
          scope: { id: 'queue:c1' },
          mutationFn: async () => {
            for (let i = 0; i < ticks; i++) await tick();
            order.push(name);
          },
        }).mutate();
      await Promise.all([write('first', 3), write('second', 1)]);
      expect(order).toEqual(['first', 'second']);
    });
  });
});

// The web is untouched: TanStack's default there, a write waits for the browser to come
// back online and is sent then (the tab stays open meanwhile).
describe('a write on the web', () => {
  it('waits for the network, as it always has', () => {
    jest.isolateModules(() => {
      const { Platform } = jest.requireActual<typeof import('react-native')>('react-native');
      const os = Platform.OS;
      Platform.OS = 'web';
      try {
        const web = jest.requireActual<typeof import('./provider')>('./provider');
        expect(web.queryClient.getDefaultOptions().mutations?.networkMode).toBeUndefined();
        expect(queryClient.getDefaultOptions().mutations?.networkMode).toBe('always');
      } finally {
        Platform.OS = os;
      }
    });
  });
});
