import { act, renderHook } from '@testing-library/react-native';

import { useMinuteClock, useNow } from './use-now';

describe('useNow', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('is the time now, refreshed every period', async () => {
    const { result } = await renderHook(() => useNow(15_000));
    expect(result.current).toBe(1_000_000);
    await act(async () => {
      jest.advanceTimersByTime(14_999);
    });
    expect(result.current).toBe(1_000_000);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBe(1_015_000);
  });

  it('stands still while disabled, and ticks again once enabled', async () => {
    const { result, rerender } = await renderHook(({ on }: { on: boolean }) => useNow(1000, on), {
      initialProps: { on: false },
    });
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(1_000_000);
    await rerender({ on: true });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(1_006_000);
  });
});

describe('useMinuteClock', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('is one clock for every reader, moving on each minute', async () => {
    const interval = jest.spyOn(global, 'setInterval');
    const a = await renderHook(() => useMinuteClock());
    const b = await renderHook(() => useMinuteClock());
    expect(interval).toHaveBeenCalledTimes(1);
    expect(a.result.current).toBe(1_000_000);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(a.result.current).toBe(1_060_000);
    expect(b.result.current).toBe(1_060_000);
    interval.mockRestore();
  });

  it('reads the time afresh for a reader turned on while it stood still', async () => {
    const { result, rerender } = await renderHook(({ on }: { on: boolean }) => useMinuteClock(on), {
      initialProps: { on: false },
    });
    await act(async () => {
      jest.advanceTimersByTime(5 * 60_000);
    });
    await rerender({ on: true });
    expect(result.current).toBe(1_300_000);
  });
});
