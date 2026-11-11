import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

const mockListeners: ((s: object) => void)[] = [];
let mockState: object = { isConnected: true, isInternetReachable: true };
// The first read's answer, when a test holds it back (else `mockState`, at once).
let mockProbe: Promise<object> | null = null;
jest.mock('expo-network', () => ({
  getNetworkStateAsync: () => mockProbe ?? Promise.resolve(mockState),
  addNetworkStateListener: (cb: (s: object) => void) => {
    mockListeners.push(cb);
    return { remove: jest.fn() };
  },
}));

/* eslint-disable import/first */
import { useDeviceOnline, watchDeviceOnline } from './device-online';
/* eslint-enable import/first */

const os = Platform.OS;
afterEach(() => {
  Platform.OS = os;
  mockListeners.length = 0;
  mockState = { isConnected: true, isInternetReachable: true };
  mockProbe = null;
});

describe('useDeviceOnline (app)', () => {
  it('follows the system network state', async () => {
    mockState = { isConnected: false, isInternetReachable: false };
    const { result } = await renderHook(() => useDeviceOnline());
    await act(async () => {});
    expect(result.current).toBe(false);
    await act(async () => mockListeners[0]({ isConnected: true, isInternetReachable: true }));
    expect(result.current).toBe(true);
  });

  it('counts an unknown reachability as online', async () => {
    mockState = { isConnected: true, isInternetReachable: null };
    const { result } = await renderHook(() => useDeviceOnline());
    await act(async () => {});
    expect(result.current).toBe(true);
  });

  // fe#179: a server on the same Wi-Fi answers with the internet down. The device has a
  // network; whether a server can be reached is that server's to say.
  it('stays online on a network with no internet (a LAN server still answers)', async () => {
    mockState = { isConnected: true, isInternetReachable: false };
    const { result } = await renderHook(() => useDeviceOnline());
    await act(async () => {});
    expect(result.current).toBe(true);
    // Losing the internet on a connected network changes nothing either.
    await act(async () => mockListeners[0]({ isConnected: true, isInternetReachable: false }));
    expect(result.current).toBe(true);
    await act(async () => mockListeners[0]({ isConnected: false, isInternetReachable: false }));
    expect(result.current).toBe(false);
  });

  it('counts an unknown connection as online', async () => {
    mockState = {};
    const { result } = await renderHook(() => useDeviceOnline());
    await act(async () => {});
    expect(result.current).toBe(true);
  });

  // Android says `isConnected: false` for a network whose transport it can't name (and for
  // a state it failed to read): not "no network", and every query waits on this flag.
  it("counts a network the system can't name as online", async () => {
    mockState = { isConnected: false, type: 'UNKNOWN' };
    const { result } = await renderHook(() => useDeviceOnline());
    await act(async () => {});
    expect(result.current).toBe(true);
    await act(async () => mockListeners[0]({ isConnected: false, type: 'NONE' }));
    expect(result.current).toBe(false);
  });

  // iOS answers the first read after up to 5 s, as "not connected" when that runs out: it
  // must not undo a change the listener told meanwhile.
  it('keeps a change heard before the first read lands', async () => {
    let land: (s: object) => void = () => undefined;
    mockProbe = new Promise((resolve) => (land = resolve));
    const { result } = await renderHook(() => useDeviceOnline());
    await act(async () => mockListeners[0]({ isConnected: true }));
    await act(async () => land({ isConnected: false, type: 'NONE' }));
    expect(result.current).toBe(true);
  });
});

describe('watchDeviceOnline (the same signal outside React)', () => {
  it('tells the state now, then every change, until stopped', async () => {
    mockState = { isConnected: true };
    const heard: boolean[] = [];
    const stop = watchDeviceOnline((online) => heard.push(online));
    await act(async () => {});
    expect(heard).toEqual([true]);
    await act(async () => mockListeners[0]({ isConnected: false }));
    await act(async () => mockListeners[0]({ isConnected: false })); // no change: no word
    await act(async () => mockListeners[0]({ isConnected: true }));
    expect(heard).toEqual([true, false, true]);
    stop();
    await act(async () => mockListeners[0]({ isConnected: false }));
    expect(heard).toEqual([true, false, true]);
  });

  it('shares the one system subscription with the hook, and agrees with it', async () => {
    mockState = { isConnected: true };
    const heard: boolean[] = [];
    const stop = watchDeviceOnline((online) => heard.push(online));
    const { result, unmount } = await renderHook(() => useDeviceOnline());
    expect(mockListeners).toHaveLength(1);
    await act(async () => mockListeners[0]({ isConnected: false }));
    expect(result.current).toBe(false);
    expect(heard.at(-1)).toBe(false);
    await unmount();
    stop();
  });
});

describe('useDeviceOnline (web)', () => {
  const g = globalThis as unknown as { window?: unknown; navigator?: unknown };
  const saved = { window: g.window, navigator: g.navigator };
  afterEach(() => {
    g.window = saved.window;
    Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true });
  });

  it("reads the browser's online flag and its events", async () => {
    Platform.OS = 'web';
    const handlers: Record<string, () => void> = {};
    g.window = {
      addEventListener: (type: string, cb: () => void) => (handlers[type] = cb),
      removeEventListener: jest.fn(),
    };
    const nav = { onLine: false };
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
    const { result, unmount } = await renderHook(() => useDeviceOnline());
    expect(result.current).toBe(false);
    nav.onLine = true;
    await act(async () => handlers.online());
    expect(result.current).toBe(true);
    await unmount();
  });
});
