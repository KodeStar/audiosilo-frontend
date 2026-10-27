import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

const mockListeners: ((s: object) => void)[] = [];
let mockState: object = { isConnected: true, isInternetReachable: true };
jest.mock('expo-network', () => ({
  getNetworkStateAsync: () => Promise.resolve(mockState),
  addNetworkStateListener: (cb: (s: object) => void) => {
    mockListeners.push(cb);
    return { remove: jest.fn() };
  },
}));

/* eslint-disable import/first */
import { useDeviceOnline } from './device-online';
/* eslint-enable import/first */

const os = Platform.OS;
afterEach(() => {
  Platform.OS = os;
  mockListeners.length = 0;
  mockState = { isConnected: true, isInternetReachable: true };
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
