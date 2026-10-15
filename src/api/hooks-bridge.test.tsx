import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { ServerInfo } from '@/api/types';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

// The Bridge hooks (Phase 1a): a book's jobs are asked only of a server with `bridge` and
// only when the screen's gate lets them (`enabled`); a job that finished after the book's
// /meta answer was fetched, or is seen turning done, has that answer read again (how the
// generated tabs appear); a write without the flag sends nothing.
function makeClient() {
  return {
    serverInfo: jest.fn<Promise<ServerInfo>, []>(),
    bridgeJobs: jest.fn(),
    queueBridgeJob: jest.fn(),
  };
}
const mockClients: Record<string, ReturnType<typeof makeClient>> = {};
jest.mock('@/api/provider', () => ({
  useApi: (id?: string) => mockClients[id ?? 'c1'],
  useApis: () => [],
  useCid: (id?: string) => id ?? 'c1',
  useOptionalApi: (id?: string) => mockClients[id ?? 'c1'] ?? null,
}));
jest.mock('@/api/reachability', () => ({ noteError: jest.fn() }));
jest.mock('@/playback/progress-sync', () => ({
  mirroredProgress: jest.fn(async () => null),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

/* eslint-disable import/first */
import { CapabilityError, qk, useBridgeJobs, useQueueBridgeJob } from '@/api/hooks';
import { bridgeJob, bridgeServer } from '@/testing/bridge-fixtures';
/* eslint-enable import/first */

notifyQueriesSynchronously();

const queryClients: QueryClient[] = [];

async function mount<T>(server: ServerInfo, useHooks: () => T) {
  mockClients.c1 = makeClient();
  mockClients.c1.serverInfo.mockResolvedValue(server);
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  queryClients.push(qc);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { ...(await renderHook(useHooks, { wrapper })), qc };
}

afterEach(() => {
  for (const qc of queryClients.splice(0)) qc.clear();
  jest.clearAllMocks();
});

const META_KEY = qk.bookMeta('c1', 1, 'Author/Book');
const useJobsOf = (opts: { enabled?: boolean } = {}) =>
  useBridgeJobs(1, 'Author/Book', { enabled: opts.enabled ?? true, active: false });

describe('useBridgeJobs', () => {
  it('asks nothing of a server without bridge, or while the screen does not let it', async () => {
    const old = bridgeServer({ bridge: undefined });
    const noFlag = { ...old, capabilities: { ...old.capabilities, bridge: false } };
    const a = await mount(noFlag, () => useJobsOf());
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    expect(a.result.current.isPending).toBe(true);
    expect(mockClients.c1.bridgeJobs).not.toHaveBeenCalled();

    const b = await mount(bridgeServer(), () => useJobsOf({ enabled: false }));
    await waitFor(() => expect(mockClients.c1.serverInfo).toHaveBeenCalled());
    expect(b.result.current.isPending).toBe(true);
    expect(mockClients.c1.bridgeJobs).not.toHaveBeenCalled();
  });

  it("reads the book's /meta again when a job finished after it was fetched", async () => {
    const { qc } = await mount(bridgeServer(), () => null);
    qc.setQueryData(
      META_KEY,
      { matched: false },
      { updatedAt: Date.parse('2026-10-15T10:00:00Z') },
    );
    mockClients.c1.bridgeJobs.mockResolvedValue([
      bridgeJob({ state: 'done', finished_at: '2026-10-15T10:05:00Z' }),
    ]);
    const { result } = await renderHook(() => useJobsOf(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryState(META_KEY)?.isInvalidated).toBe(true);
  });

  it('keeps a /meta answer fetched after the job finished', async () => {
    const { qc } = await mount(bridgeServer(), () => null);
    qc.setQueryData(
      META_KEY,
      { matched: false },
      { updatedAt: Date.parse('2026-10-15T11:00:00Z') },
    );
    mockClients.c1.bridgeJobs.mockResolvedValue([
      bridgeJob({ state: 'done', finished_at: '2026-10-15T10:05:00Z' }),
    ]);
    const { result } = await renderHook(() => useJobsOf(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryState(META_KEY)?.isInvalidated).toBe(false);
  });

  it('reads /meta again when it sees the job turn done, whatever the clocks say', async () => {
    const { qc } = await mount(bridgeServer(), () => null);
    // The device clock runs ahead: the answer looks newer than the finish.
    qc.setQueryData(
      META_KEY,
      { matched: false },
      { updatedAt: Date.parse('2030-01-01T00:00:00Z') },
    );
    mockClients.c1.bridgeJobs.mockResolvedValueOnce([bridgeJob({ state: 'running' })]);
    const { result } = await renderHook(() => useJobsOf(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryState(META_KEY)?.isInvalidated).toBe(false);
    mockClients.c1.bridgeJobs.mockResolvedValueOnce([
      bridgeJob({ state: 'done', finished_at: '2026-10-15T10:05:00Z' }),
    ]);
    await act(async () => {
      await result.current.refetch();
    });
    expect(qc.getQueryState(META_KEY)?.isInvalidated).toBe(true);
  });
});

describe('useBridgeJobs after a finish', () => {
  const PREVIOUS_KEY = qk.bookMeta('c1', 1, 'Author/Book', { includePrevious: true });
  const ITEM_KEY = qk.item('c1', 1, 'Author/Book');
  const finished = () => [bridgeJob({ state: 'done', finished_at: '2026-10-15T10:05:00Z' })];

  it("reads every /meta variant and the book's item again when it sees the job turn done", async () => {
    const { qc } = await mount(bridgeServer(), () => null);
    const later = { updatedAt: Date.parse('2030-01-01T00:00:00Z') };
    qc.setQueryData(PREVIOUS_KEY, { matched: false }, later);
    qc.setQueryData(ITEM_KEY, { rel_path: 'Author/Book' }, later);
    mockClients.c1.bridgeJobs.mockResolvedValueOnce([bridgeJob({ state: 'running' })]);
    const { result } = await renderHook(() => useJobsOf(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    mockClients.c1.bridgeJobs.mockResolvedValueOnce(finished());
    await act(async () => {
      await result.current.refetch();
    });
    expect(qc.getQueryState(PREVIOUS_KEY)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(ITEM_KEY)?.isInvalidated).toBe(true);
  });

  // A device clock behind the server's makes every later answer look older than the
  // finish: it is acted on once, not on every read of the jobs.
  it('reads them again once per finish, whatever the clocks say', async () => {
    const { qc } = await mount(bridgeServer(), () => null);
    const early = { updatedAt: Date.parse('2026-10-15T10:00:00Z') };
    qc.setQueryData(META_KEY, { matched: false }, early);
    mockClients.c1.bridgeJobs.mockResolvedValue(finished());
    const { result } = await renderHook(() => useJobsOf(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryState(META_KEY)?.isInvalidated).toBe(true);
    // The answer read again, still stamped before the finish by the slow clock.
    qc.setQueryData(META_KEY, { matched: false }, early);
    expect(qc.getQueryState(META_KEY)?.isInvalidated).toBe(false);
    await act(async () => {
      await result.current.refetch();
    });
    expect(qc.getQueryState(META_KEY)?.isInvalidated).toBe(false);
  });
});

describe('useQueueBridgeJob', () => {
  it('sends nothing to a server without bridge', async () => {
    const old = bridgeServer({ bridge: undefined });
    const { result, qc } = await mount(
      { ...old, capabilities: { ...old.capabilities, bridge: false } },
      () => useQueueBridgeJob(),
    );
    await waitFor(() => expect(qc.getQueryData(qk.server('c1'))).toBeDefined());
    await act(async () => {
      await expect(
        result.current.mutateAsync({ kind: 'sidecars.generate', library_id: 1, path: 'x' }),
      ).rejects.toBeInstanceOf(CapabilityError);
    });
    expect(mockClients.c1.queueBridgeJob).not.toHaveBeenCalled();
  });

  it("puts the queued job at the head of its book's list", async () => {
    const { result, qc } = await mount(bridgeServer(), () => useQueueBridgeJob());
    const listKey = qk.bridgeJobs('c1', 1, 'Author/Book');
    const old = bridgeJob({ id: 1, state: 'failed' });
    qc.setQueryData(listKey, [old]);
    const queued = bridgeJob({ id: 2, state: 'queued' });
    mockClients.c1.queueBridgeJob.mockResolvedValue(queued);
    await waitFor(() => expect(qc.getQueryData(qk.server('c1'))).toBeDefined());
    await act(async () => {
      await result.current.mutateAsync({
        kind: 'sidecars.generate',
        library_id: 1,
        path: 'Author/Book',
      });
    });
    expect(qc.getQueryData(listKey)).toEqual([queued, old]);
  });
});
