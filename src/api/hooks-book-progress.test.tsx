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
  bookPlace: (...a: unknown[]) => mockMirrored(...a),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

/* eslint-disable import/first */
import { useBookProgress } from '@/api/hooks';
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
