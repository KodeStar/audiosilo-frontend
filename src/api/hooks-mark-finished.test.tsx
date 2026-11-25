import { onlineManager, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { setConnectionAliases } from '@/lib/connection-id';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

// `useMarkFinished`: both of its routes work offline (a `finish` event waits in the outbox,
// a legacy save in the queue), so the mutation must run whatever the online flag says.
jest.mock('@/api/provider', () => {
  const { QueryClient } = jest.requireActual('@tanstack/react-query');
  return {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    useCid: (cid?: string) => cid ?? 'c1',
    useApi: () => ({}),
    useApis: () => ({}),
    useOptionalApi: () => ({}),
  };
});
const mockRecord = jest.fn(async (..._a: unknown[]) => true);
jest.mock('@/playback/finish-route', () => ({
  ...jest.requireActual('@/playback/finish-route'),
  recordFinishEvent: (...a: unknown[]) => mockRecord(...a),
}));
const mockSave = jest.fn(async (..._a: unknown[]) => 'queued');
jest.mock('@/playback/progress-sync', () => ({
  saveProgress: (...a: unknown[]) => mockSave(...a),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

/* eslint-disable import/first */
import { finishDelivered } from '@/playback/finish-delivery';
import { qk, useMarkFinished } from '@/api/hooks';
import { queryClient } from '@/api/provider';
/* eslint-enable import/first */

notifyQueriesSynchronously();

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
const finish = { libraryId: 1, path: 'A/Book', position: 3600, duration: 3600 };

beforeEach(() => {
  queryClient.clear();
  mockRecord.mockClear();
  mockSave.mockClear();
  onlineManager.setOnline(false);
});
afterEach(() => onlineManager.setOnline(true));

it('offline, the finish event is recorded at once (not held for the network)', async () => {
  const { result } = await renderHook(() => useMarkFinished('c1'), { wrapper });
  const onSuccess = jest.fn();
  await act(async () => result.current.mutate(finish, { onSuccess }));
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({ connectionId: 'c1', ...finish }),
  );
  expect(onSuccess).toHaveBeenCalled();
});

it('offline on the PUT path, the save is queued at once', async () => {
  mockRecord.mockResolvedValueOnce(false);
  const { result } = await renderHook(() => useMarkFinished('c1'), { wrapper });
  await act(async () => result.current.mutateAsync(finish));
  expect(mockSave).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ finished: true, position: 3600, duration: 3600 }),
  );
});

it('one delivery refreshes the shared list, stats and goal once and each affected book', async () => {
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  try {
    const { result } = await renderHook(() => useMarkFinished('c1'), { wrapper });
    await act(async () => result.current.mutateAsync(finish));
    expect(invalidate).not.toHaveBeenCalled();
    finishDelivered('c1', [finish, { libraryId: 2, path: 'Other' }]);
    const keys = invalidate.mock.calls.map(([options]) => options?.queryKey);
    for (const key of [
      qk.allProgress('c1'),
      qk.myStatsAll('c1'),
      qk.listeningGoal('c1'),
      qk.progress('c1', 1, 'A/Book'),
      qk.progress('c1', 2, 'Other'),
      qk.bookMeta('c1', 1, 'A/Book'),
      qk.bookMeta('c1', 2, 'Other'),
    ]) {
      expect(keys.filter((k) => JSON.stringify(k) === JSON.stringify(key))).toHaveLength(1);
    }
  } finally {
    invalidate.mockRestore();
  }
});

it('replaces an older first list GET after the migrated connection delivers, without cancelling a sibling account', async () => {
  onlineManager.setOnline(true);
  setConnectionAliases({ legacy: 'legacy.7' });
  let settleOld!: (rows: string[]) => void;
  const list = jest
    .fn<Promise<string[]>, []>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleOld = resolve;
        }),
    )
    .mockResolvedValue(['finished']);
  const sibling = jest.fn(() => new Promise<string[]>(() => {}));
  try {
    const { result } = await renderHook(
      () => ({
        book: useQuery({ queryKey: qk.allProgress('legacy.7'), queryFn: list }),
        sibling: useQuery({ queryKey: qk.allProgress('legacy.8'), queryFn: sibling }),
      }),
      { wrapper },
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await act(async () => finishDelivered('legacy', [finish]));
    await waitFor(() => expect(result.current.book.data).toEqual(['finished']));
    await act(async () => settleOld(['in progress']));
    expect(result.current.book.data).toEqual(['finished']);
    expect(list).toHaveBeenCalledTimes(2);
    expect(sibling).toHaveBeenCalledTimes(1);
  } finally {
    setConnectionAliases({});
  }
});

it('leaves a first list GET nobody observes to its fetchQuery caller (the car, what plays next)', async () => {
  onlineManager.setOnline(true);
  let settle!: (rows: string[]) => void;
  const read = queryClient.fetchQuery({
    queryKey: qk.allProgress('c1'),
    queryFn: () =>
      new Promise<string[]>((resolve) => {
        settle = resolve;
      }),
  });
  finishDelivered('c1', [finish]);
  settle(['in progress']);
  await expect(read).resolves.toEqual(['in progress']);
});
