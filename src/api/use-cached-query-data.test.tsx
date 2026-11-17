import { act, renderHook } from '@testing-library/react-native';

import { queryClient } from './provider';
import { useCachedQueryData } from './use-cached-query-data';

const KEY = ['cached-probe', 1] as const;

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

  it('reads nothing and listens to nothing while not enabled', async () => {
    queryClient.setQueryData(KEY, 'first');
    const subscribe = jest.spyOn(queryClient.getQueryCache(), 'subscribe');
    try {
      const { result, rerender } = await renderHook(
        ({ on }: { on: boolean }) => useCachedQueryData<string>(KEY, on),
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
