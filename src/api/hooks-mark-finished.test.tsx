import { onlineManager, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

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
import { useMarkFinished } from '@/api/hooks';
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
