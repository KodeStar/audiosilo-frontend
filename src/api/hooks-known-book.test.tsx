import { onlineManager, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { notifyQueriesSynchronously } from '@/testing/query-notify';

// `useKnownBook` (v2.5.1 PLAYER-02): a book Home knows only by path keeps the title a
// cached list holds while its own `/item` can't answer.
const mockItem = jest.fn();
jest.mock('@/api/provider', () => {
  const { QueryClient } = jest.requireActual('@tanstack/react-query');
  return {
    queryClient: new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    }),
    useCid: (cid?: string) => cid ?? 'c1',
    useOptionalApi: () => ({ item: (...a: unknown[]) => mockItem(...a) }),
  };
});
jest.mock('@/api/reachability', () => ({ noteFailure: jest.fn() }));
jest.mock('@/playback/progress-sync', () => ({
  mirroredProgress: jest.fn(async () => null),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

/* eslint-disable import/first */
import { useKnownBook } from '@/api/hooks';
import { queryClient } from '@/api/provider';
/* eslint-enable import/first */

notifyQueriesSynchronously();

const PATH = 'Corey/03 - Abaddons Gate';
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  queryClient.clear();
  mockItem.mockReset();
  queryClient.setQueryData(
    ['recent', 'c1'],
    [{ library_id: 1, rel_path: PATH, title: "Abaddon's Gate", author: 'James S. A. Corey' }],
  );
});

afterEach(() => onlineManager.setOnline(true));

it("takes the cached list's copy while the item waits for the network", async () => {
  onlineManager.setOnline(false);
  const { result } = await renderHook(() => useKnownBook(1, PATH), { wrapper });
  await waitFor(() => expect(result.current?.title).toBe("Abaddon's Gate"));
  expect(mockItem).not.toHaveBeenCalled();
});

it('takes it when the item failed, and the item itself when it answers', async () => {
  mockItem.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  const failed = await renderHook(() => useKnownBook(1, PATH), { wrapper });
  await waitFor(() => expect(failed.result.current?.author).toBe('James S. A. Corey'));

  queryClient.removeQueries({ queryKey: ['item'] });
  mockItem.mockResolvedValueOnce({ library_id: 1, rel_path: PATH, title: 'From the item' });
  const answered = await renderHook(() => useKnownBook(1, PATH), { wrapper });
  await waitFor(() => expect(answered.result.current?.title).toBe('From the item'));
});

it('waits for the item online, rather than walking the cache', async () => {
  mockItem.mockReturnValue(new Promise(() => {}));
  const { result } = await renderHook(() => useKnownBook(1, PATH), { wrapper });
  expect(result.current).toBeUndefined();
});
