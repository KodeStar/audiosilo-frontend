import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Capabilities, ServerInfo, UpcomingResponse } from '@/api/types';
import { notifyQueriesSynchronously } from '@/testing/query-notify';
import { upcomingItem } from '@/testing/upcoming-fixtures';

// Upcoming (Track U2) asks only a connection whose server advertises `upcoming` and whose
// user is not a kid (the route refuses a kid with a 403): every other connection has no
// query function, so it is never asked. The provider is mocked to list the connections of
// `mockConnections` (each with its user), in order, each with its own stub client.
type Stub = { serverInfo: jest.Mock; upcoming: jest.Mock };
type MockConnection = { id: string; name: string; user: { member_kind?: 'kid' } };
const mockClients: Record<string, Stub> = {};
let mockConnections: MockConnection[] = [];
jest.mock('@/api/provider', () => ({
  useApis: () => mockConnections.map((c) => ({ connection: c, client: mockClients[c.id] })),
  useCid: (id?: string) => id ?? mockConnections[0]?.id ?? '',
  useOptionalApi: (id?: string) => mockClients[id ?? mockConnections[0]?.id] ?? null,
}));

/* eslint-disable import/first */
import { useUpcomingAll, useUpcomingAvailable } from '@/api/hooks';
/* eslint-enable import/first */

function serverWith(id: string, caps: Partial<Capabilities>): ServerInfo {
  return {
    name: id,
    server_id: id,
    version: '2.6.0',
    api: 'v1',
    capabilities: {
      admin_ui: true,
      web_player: true,
      transcode: false,
      upload: false,
      websocket: false,
      ...caps,
    },
    auth: { methods: [] },
  };
}

notifyQueriesSynchronously();

const queryClients: QueryClient[] = [];

type Setup = {
  id: string;
  caps: Partial<Capabilities> | 'pending';
  kid?: boolean;
  answer?: Partial<UpcomingResponse> | 'fail';
};

async function mount<T>(setups: Setup[], useHook: () => T) {
  mockConnections = setups.map((s) => ({
    id: s.id,
    name: `Server ${s.id}`,
    user: s.kid ? { member_kind: 'kid' } : {},
  }));
  for (const s of setups) {
    const stub: Stub = { serverInfo: jest.fn(), upcoming: jest.fn() };
    if (s.caps === 'pending') stub.serverInfo.mockReturnValue(new Promise(() => {}));
    else stub.serverInfo.mockResolvedValue(serverWith(s.id, s.caps));
    if (s.answer === 'fail') stub.upcoming.mockRejectedValue(new Error('down'));
    else stub.upcoming.mockResolvedValue({ status: 'ok', window_days: 90, items: [], ...s.answer });
    mockClients[s.id] = stub;
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  queryClients.push(qc);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(useHook, { wrapper });
}

afterEach(() => {
  for (const qc of queryClients.splice(0)) qc.clear();
  for (const id of Object.keys(mockClients)) delete mockClients[id];
  mockConnections = [];
});

describe('useUpcomingAll', () => {
  it('merges two servers, each work once, in the order across servers', async () => {
    const { result } = await mount(
      [
        {
          id: 'a',
          caps: { upcoming: true },
          answer: {
            items: [
              upcomingItem({ id: 'shared', kind: 'preorder', release_date: '2027' }),
              upcomingItem({ id: 'a-missing' }),
            ],
          },
        },
        {
          id: 'b',
          caps: { upcoming: true },
          answer: {
            items: [
              upcomingItem({ id: 'b-soon', kind: 'preorder', release_date: '2026-11-12' }),
              upcomingItem({ id: 'shared', kind: 'preorder', release_date: '2027' }),
              upcomingItem({ id: 'b-out', kind: 'released', release_date: '2026-10-01' }),
            ],
          },
        },
      ],
      useUpcomingAll,
    );
    await waitFor(() => expect(result.current.items).toHaveLength(4));
    expect(result.current.items.map((i) => [i.work.id, i.connectionId])).toEqual([
      ['b-soon', 'b'],
      ['shared', 'a'],
      ['b-out', 'b'],
      ['a-missing', 'a'],
    ]);
    expect(result.current.items[0].connectionName).toBe('Server b');
    expect(result.current.available).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it('never asks a server without the flag, nor a kid connection', async () => {
    const { result } = await mount(
      [
        { id: 'old', caps: {} },
        { id: 'off', caps: { upcoming: false } },
        { id: 'kid', caps: { upcoming: true }, kid: true },
        { id: 'on', caps: { upcoming: true }, answer: { items: [upcomingItem({ id: 'w' })] } },
      ],
      useUpcomingAll,
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(mockClients.on.upcoming).toHaveBeenCalledTimes(1);
    expect(mockClients.old.upcoming).not.toHaveBeenCalled();
    expect(mockClients.off.upcoming).not.toHaveBeenCalled();
    expect(mockClients.kid.upcoming).not.toHaveBeenCalled();
    expect(result.current.statuses.map((s) => s.connectionId)).toEqual(['on']);
  });

  it('is unavailable, asking nothing, when no connection can have it', async () => {
    const { result } = await mount(
      [
        { id: 'old', caps: {} },
        { id: 'kid', caps: { upcoming: true }, kid: true },
      ],
      () => ({ all: useUpcomingAll(), available: useUpcomingAvailable() }),
    );
    await waitFor(() => expect(result.current.all.available).toBe(false));
    expect(result.current.available).toBe(false);
    expect(result.current.all.items).toEqual([]);
    expect(mockClients.old.upcoming).not.toHaveBeenCalled();
    expect(mockClients.kid.upcoming).not.toHaveBeenCalled();
  });

  it("is not known while a server's flags are loading", async () => {
    const { result } = await mount([{ id: 'a', caps: 'pending' }], useUpcomingAvailable);
    expect(result.current).toBeUndefined();
    expect(mockClients.a.upcoming).not.toHaveBeenCalled();
  });

  it('passes each server status through, and a failed server adds nothing', async () => {
    const { result } = await mount(
      [
        { id: 'p', caps: { upcoming: true }, answer: { status: 'pending', items: [] } },
        {
          id: 's',
          caps: { upcoming: true },
          answer: { status: 'stale', items: [upcomingItem({ id: 'old-news' })] },
        },
        { id: 'x', caps: { upcoming: true }, answer: 'fail' },
      ],
      useUpcomingAll,
    );
    await waitFor(() => expect(result.current.statuses).toHaveLength(2));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.statuses).toEqual([
      { connectionId: 'p', connectionName: 'Server p', status: 'pending' },
      { connectionId: 's', connectionName: 'Server s', status: 'stale' },
    ]);
    expect(result.current.items.map((i) => i.work.id)).toEqual(['old-news']);
    expect(mockClients.x.upcoming).toHaveBeenCalled();
  });
});
