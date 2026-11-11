import { onlineManager, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { notifyQueriesSynchronously } from '@/testing/query-notify';

// `useBookProgress`: with no network the read still runs, so it reaches this device's
// mirror (a downloaded book opened offline knows its place). Held for the online flag, as
// the app holds its queries with no network, it never ran.
const mockGetProgress = jest.fn();
jest.mock('@/api/provider', () => {
  const { QueryClient } = jest.requireActual('@tanstack/react-query');
  return {
    queryClient: new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    }),
    useCid: (cid?: string) => cid ?? 'c1',
    useOptionalApi: () => ({ getProgress: (...a: unknown[]) => mockGetProgress(...a) }),
  };
});
jest.mock('@/api/reachability', () => ({
  noteFailure: jest.fn(),
  useReachability: (sel: (s: { online: Record<string, boolean> }) => unknown) =>
    sel({ online: {} }),
}));
const mockMirrored = jest.fn();
jest.mock('@/playback/progress-sync', () => ({
  positionOn: jest.requireActual('@/playback/progress-sync').positionOn,
  bookPlace: (...a: unknown[]) => mockMirrored(...a),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

/* eslint-disable import/first */
import { qk, useBookProgress } from '@/api/hooks';
import { queryClient } from '@/api/provider';
/* eslint-enable import/first */

notifyQueriesSynchronously();

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  queryClient.clear();
  mockGetProgress.mockReset();
  mockMirrored.mockReset();
});
afterEach(() => onlineManager.setOnline(true));

it("offline, reads this device's place rather than waiting for the network", async () => {
  onlineManager.setOnline(false);
  mockGetProgress.mockRejectedValue(new TypeError('Network request failed'));
  mockMirrored.mockResolvedValue({ library_id: 1, path: 'A/Book', position: 120 });
  const { result } = await renderHook(() => useBookProgress(1, 'A/Book', true), { wrapper });
  await waitFor(() => expect(result.current.data).toMatchObject({ position: 120 }));
  expect(mockMirrored).toHaveBeenCalledWith(undefined, 'c1', 1, 'A/Book');
});

// fe#188: a place this device saved in a download's old file order reads, for every caller,
// where Resume plays it on the chapters the cache holds (the server's new order).
describe('the file place, on the cached chapters', () => {
  const place = {
    library_id: 1,
    path: 'B',
    position: 130, // 30 s into B/2 in the old order (B/1 first, 100 s)
    duration: 160,
    finished: false,
    file: { path: 'B/2.mp3', pos: 30 },
  };
  const serverOrder = {
    files: [
      { rel_path: 'B/2.mp3', seq: 0, duration: 60 },
      { rel_path: 'B/1.mp3', seq: 1, duration: 100 },
    ],
  };

  it('reads the place on the chapters the cache holds, and follows them', async () => {
    mockGetProgress.mockResolvedValue(null);
    mockMirrored.mockResolvedValue(place);
    queryClient.setQueryData(qk.chapters('c1', 1, 'B'), serverOrder);
    const { result } = await renderHook(() => useBookProgress(1, 'B', true), { wrapper });
    // B/2 is first now: 30 s into the book.
    await waitFor(() => expect(result.current.data?.position).toBe(30));
    // An answer in the old order again: the place reads there.
    queryClient.setQueryData(qk.chapters('c1', 1, 'B'), {
      files: [...serverOrder.files].reverse().map((f, seq) => ({ ...f, seq })),
    });
    await waitFor(() => expect(result.current.data?.position).toBe(130));
    // The cache keeps the record's own seconds.
    expect(
      queryClient.getQueryData<{ position: number }>(qk.progress('c1', 1, 'B'))?.position,
    ).toBe(130);
  });

  it("keeps the record's own seconds with no chapters cached, and never asks for them", async () => {
    mockGetProgress.mockResolvedValue(null);
    mockMirrored.mockResolvedValue(place);
    const { result } = await renderHook(() => useBookProgress(1, 'B', true), { wrapper });
    await waitFor(() => expect(result.current.data?.position).toBe(130));
    expect(queryClient.getQueryState(qk.chapters('c1', 1, 'B'))?.fetchStatus ?? 'idle').toBe(
      'idle',
    );
  });
});
