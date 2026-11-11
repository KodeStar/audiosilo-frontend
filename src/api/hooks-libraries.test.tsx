import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { notifyQueriesSynchronously } from '@/testing/query-notify';

// `useLibrariesAll` across two servers whose lists both failed: a server's own Retry
// (`retryServer`, Folders mode, CONNECT-06) asks only that server again.
const mockApis = [
  {
    connection: { id: 'a', name: 'Home' },
    client: { libraries: jest.fn(), listBooks: jest.fn(), serverInfo: jest.fn() },
  },
  { connection: { id: 'b', name: "Maya's Shelf" }, client: { libraries: jest.fn() } },
];
jest.mock('@/api/provider', () => ({
  useApis: () => mockApis,
  useOptionalApi: () => mockApis[0].client,
  useCid: (id?: string) => id ?? 'a',
}));
jest.mock('@/api/reachability', () => ({ noteFailure: jest.fn() }));
jest.mock('@/playback/progress-sync', () => ({
  mirroredProgress: jest.fn(async () => null),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

/* eslint-disable import/first */
import { useAllLibraryBooks, useLibrariesAll } from '@/api/hooks';
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

it('marks a list that waits for the network (offline before it answered) as paused (fe#155)', async () => {
  const [a, b] = mockApis.map((x) => x.client.libraries);
  a.mockResolvedValue([]);
  b.mockResolvedValue([]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  onlineManager.setOnline(false);
  try {
    const { result } = await renderHook(() => useLibrariesAll(), { wrapper });
    await waitFor(() =>
      expect(result.current.groups.map((g) => [g.status, g.paused])).toEqual([
        ['loading', true],
        ['loading', true],
      ]),
    );
    // Not loading (no skeleton for good): offline until the network is back.
    expect(result.current).toMatchObject({ isLoading: false, offline: true });
    await act(async () => onlineManager.setOnline(true));
    await waitFor(() =>
      expect(result.current.groups.map((g) => [g.status, g.paused])).toEqual([
        ['ready', false],
        ['ready', false],
      ]),
    );
    expect(result.current).toMatchObject({ isLoading: false, offline: false });
  } finally {
    onlineManager.setOnline(true);
    qc.clear();
  }
});

// fe#179 (the RC3 re-check): the Library grid's whole-library read, held for the network
// with nothing loaded, is `offline`: its screen shows the offline state, not a skeleton
// that never ends.
it('says a whole-library read that waits for the network is offline, then loads it', async () => {
  const { listBooks, serverInfo } = mockApis[0].client;
  serverInfo!.mockResolvedValue({ capabilities: {} });
  listBooks!.mockResolvedValue({ books: [{ rel_path: 'Dune' }], next_cursor: '' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  onlineManager.setOnline(false);
  try {
    const { result } = await renderHook(() => useAllLibraryBooks(1, { sort: 'recent' }, 'a'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.offline).toBe(true));
    expect(result.current.books).toEqual([]);
    expect(listBooks).not.toHaveBeenCalled();
    await act(async () => onlineManager.setOnline(true));
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current).toMatchObject({ offline: false, isLoading: false });
    expect(result.current.books).toEqual([{ rel_path: 'Dune' }]);
  } finally {
    onlineManager.setOnline(true);
    qc.clear();
  }
});
