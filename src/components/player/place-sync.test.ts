import { act, renderHook } from '@testing-library/react-native';

const mockCount = jest.fn(async () => 0);
jest.mock('@/playback/progress-sync', () => ({ pendingSaveCount: () => mockCount() }));
jest.mock('expo-router', () => ({ useIsFocused: () => true }));

/* eslint-disable import/first */
import { useReachability } from '@/api/reachability';
import { usePendingSaves } from '@/components/home/use-sync-pill';

import { placeSync } from './place-sync';
/* eslint-enable import/first */

describe('placeSync', () => {
  it('says sign in again first, then kept here while offline or queued, else synced', () => {
    expect(placeSync('reconnect', 3, true)).toBe('reconnect');
    expect(placeSync('offline', 0, true)).toBe('local');
    expect(placeSync('online', 2, false)).toBe('local');
    expect(placeSync('online', 0, true)).toBe('synced-now');
    expect(placeSync('online', 0, false)).toBe('synced');
  });
});

describe('usePendingSaves', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockCount.mockClear();
    mockCount.mockResolvedValue(0);
    useReachability.setState({ online: {} });
  });
  afterEach(() => jest.useRealTimers());

  const tick = (ms: number) =>
    act(async () => {
      jest.advanceTimersByTime(ms);
      await Promise.resolve();
    });

  it('polls every 20 s by default (Home)', async () => {
    await renderHook(() => usePendingSaves());
    expect(mockCount).toHaveBeenCalledTimes(1);
    await tick(40_000);
    expect(mockCount).toHaveBeenCalledTimes(3);
  });

  it('for the player, reads once while all is clear and polls only while offline', async () => {
    await renderHook(() => usePendingSaves({ pollWhenClear: false }));
    expect(mockCount).toHaveBeenCalledTimes(1);
    await tick(60_000);
    expect(mockCount).toHaveBeenCalledTimes(1);
    // A server goes away: read again, then keep reading while it is gone.
    await act(async () => useReachability.setState({ online: { a: false } }));
    expect(mockCount).toHaveBeenCalledTimes(2);
    await tick(20_000);
    expect(mockCount).toHaveBeenCalledTimes(3);
  });

  it('keeps polling while saves wait, until the queue drains', async () => {
    mockCount.mockResolvedValue(2);
    const { result } = await renderHook(() => usePendingSaves({ pollWhenClear: false }));
    await tick(0);
    expect(result.current).toBe(2);
    const reads = mockCount.mock.calls.length;
    await tick(20_000);
    expect(mockCount.mock.calls.length).toBeGreaterThan(reads);
    mockCount.mockResolvedValue(0);
    await tick(20_000);
    expect(result.current).toBe(0);
    // Drained and online: no more polling.
    const drained = mockCount.mock.calls.length;
    await tick(60_000);
    expect(mockCount.mock.calls.length).toBe(drained);
  });
});
