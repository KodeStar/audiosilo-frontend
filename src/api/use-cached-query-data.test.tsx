import { QueryClient } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';

import { notifyQueriesSynchronously } from '@/testing/query-notify';

import { queryClient } from './provider';
import { useCachedQueryData, useCachedQueryState } from './use-cached-query-data';

const KEY = ['cached-probe', 1] as const;

notifyQueriesSynchronously();

afterEach(() => queryClient.removeQueries({ queryKey: ['cached-probe'] }));

describe('useCachedQueryData', () => {
  it('follows the entry: a write to the cache renders the reader again with it', async () => {
    queryClient.setQueryData(KEY, 'first');
    const { result } = await renderHook(() => useCachedQueryData<string>(KEY));
    expect(result.current).toBe('first');
    // Nothing else renders the reader: only its own listener can bring the new value.
    await act(async () => void queryClient.setQueryData(KEY, 'second'));
    expect(result.current).toBe('second');
    await act(async () => queryClient.removeQueries({ queryKey: KEY }));
    expect(result.current).toBeUndefined();
  });

  it('asks nothing and builds no query for an entry the cache does not hold', async () => {
    const { result } = await renderHook(() => useCachedQueryData<string>(KEY));
    expect(result.current).toBeUndefined();
    expect(queryClient.getQueryCache().find({ queryKey: KEY })).toBeUndefined();
  });

  it('reads nothing and listens to nothing without a key', async () => {
    queryClient.setQueryData(KEY, 'first');
    const subscribe = jest.spyOn(queryClient.getQueryCache(), 'subscribe');
    try {
      const { result, rerender } = await renderHook(
        ({ on }: { on: boolean }) => useCachedQueryData<string>(on && KEY),
        { initialProps: { on: false } },
      );
      expect(result.current).toBeUndefined();
      expect(subscribe).not.toHaveBeenCalled();
      await rerender({ on: true });
      expect(result.current).toBe('first');
      expect(subscribe).toHaveBeenCalledTimes(1);
    } finally {
      subscribe.mockRestore();
    }
  });
});

describe('useCachedQueryState', () => {
  it("reads what it picks from another client's entry, and follows it", async () => {
    const other = new QueryClient();
    other.setQueryData(KEY, 'first');
    const { result } = await renderHook(() =>
      useCachedQueryState(KEY, (s) => s?.dataUpdatedAt ?? 0, other),
    );
    const first = result.current;
    expect(first).toBeGreaterThan(0);
    // The app's own client holds no such entry: the other one was read.
    expect(queryClient.getQueryData(KEY)).toBeUndefined();
    jest.spyOn(Date, 'now').mockReturnValue(first + 5_000);
    try {
      await act(async () => void other.setQueryData(KEY, 'second'));
    } finally {
      jest.restoreAllMocks();
    }
    expect(result.current).toBe(first + 5_000);
  });

  it('picks from nothing without an entry', async () => {
    const { result } = await renderHook(() =>
      useCachedQueryState(KEY, (s) => s?.dataUpdatedAt ?? 0),
    );
    expect(result.current).toBe(0);
  });
});
