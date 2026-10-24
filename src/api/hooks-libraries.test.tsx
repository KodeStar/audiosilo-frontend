import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { notifyQueriesSynchronously } from '@/testing/query-notify';

// `useLibrariesAll` across two servers whose lists both failed: a server's own Retry
// (`retryServer`, Folders mode, CONNECT-06) asks only that server again.
const mockApis = [
  { connection: { id: 'a', name: 'Home' }, client: { libraries: jest.fn() } },
  { connection: { id: 'b', name: "Maya's Shelf" }, client: { libraries: jest.fn() } },
];
jest.mock('@/api/provider', () => ({ useApis: () => mockApis }));
jest.mock('@/api/reachability', () => ({ noteFailure: jest.fn() }));
jest.mock('@/playback/progress-sync', () => ({
  mirroredProgress: jest.fn(async () => null),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

/* eslint-disable import/first */
import { useLibrariesAll } from '@/api/hooks';
/* eslint-enable import/first */

notifyQueriesSynchronously();

it("asks only that server again on a server's own Retry", async () => {
  const [a, b] = mockApis.map((x) => x.client.libraries);
  a.mockRejectedValue(new TypeError('Network request failed'));
  b.mockRejectedValue(new TypeError('Network request failed'));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  try {
    const { result } = await renderHook(() => useLibrariesAll(), { wrapper });
    await waitFor(() =>
      expect(result.current.groups.map((g) => g.status)).toEqual(['error', 'error']),
    );
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    await act(async () => result.current.retryServer('b'));
    await waitFor(() => expect(b).toHaveBeenCalledTimes(2));
    expect(a).toHaveBeenCalledTimes(1);
  } finally {
    qc.clear();
  }
});
