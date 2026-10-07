import { QueryClient, QueryClientProvider, skipToken } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { notifyQueriesSynchronously } from '@/testing/query-notify';

import { type InfiniteQueriesOptions, useInfiniteQueries } from './use-infinite-queries';

notifyQueriesSynchronously();

type P = { items: string[]; next?: number };
const load = jest.fn(async (id: string, page: number): Promise<P> => ({
  items: [`${id}${page}`],
  next: page < 1 ? page + 1 : undefined,
}));

const options = (id: string, on = true): InfiniteQueriesOptions<P, number> => ({
  queryKey: ['list', id],
  queryFn: on ? ({ pageParam }) => load(id, pageParam) : skipToken,
  initialPageParam: 0,
  getNextPageParam: (last) => last.next,
});

let qc: QueryClient;
beforeEach(() => {
  load.mockClear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => qc.clear());

function mount(initial: InfiniteQueriesOptions<P, number>[]) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ list }: { list: InfiniteQueriesOptions<P, number>[] }) => useInfiniteQueries(list),
    { wrapper, initialProps: { list: initial } },
  );
}

describe('useInfiniteQueries', () => {
  it('runs one infinite query per entry, each paging on its own', async () => {
    const { result } = await mount([options('a'), options('b')]);
    await waitFor(() => expect(result.current.every((r) => r.isSuccess)).toBe(true));
    expect(result.current.map((r) => r.data?.pages[0].items)).toEqual([['a0'], ['b0']]);
    await act(async () => void (await result.current[1].fetchNextPage()));
    expect(result.current[1].data?.pages.map((p) => p.items[0])).toEqual(['b0', 'b1']);
    expect(result.current[0].data?.pages).toHaveLength(1);
    expect(result.current[1].hasNextPage).toBe(false);
  });

  it('hands back the same results while nothing changed', async () => {
    const { result, rerender } = await mount([options('a')]);
    await waitFor(() => expect(result.current[0].isSuccess).toBe(true));
    const before = result.current;
    await rerender({ list: [options('a')] });
    expect(result.current).toBe(before);
  });

  it('asks nothing behind skipToken, and starts once the entry has a query function', async () => {
    const { result, rerender } = await mount([options('a', false)]);
    expect(result.current[0].isPending).toBe(true);
    expect(load).not.toHaveBeenCalled();
    await rerender({ list: [options('a')] });
    await waitFor(() => expect(result.current[0].isSuccess).toBe(true));
    expect(load).toHaveBeenCalledWith('a', 0);
  });

  it('keeps a query through changes to the list around it, and lets a dropped one go', async () => {
    const { result, rerender } = await mount([options('a'), options('b')]);
    await waitFor(() => expect(result.current.every((r) => r.isSuccess)).toBe(true));
    const a = result.current[0];
    await rerender({ list: [options('c'), options('a')] });
    await waitFor(() => expect(result.current[0].isSuccess).toBe(true));
    expect(result.current[1]).toBe(a);
    expect(load).toHaveBeenCalledTimes(3);
    expect(
      qc
        .getQueryCache()
        .find({ queryKey: ['list', 'b'] })
        ?.getObserversCount(),
    ).toBe(0);
  });
});
