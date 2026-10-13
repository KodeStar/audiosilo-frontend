import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { ApiError } from '@/api/client';
import type { Capabilities, HouseholdMember, HouseholdMembers, ServerInfo } from '@/api/types';
import { householdMember } from '@/testing/household-fixtures';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

// The household member hooks (player redesign Phase 8b-1) ask only a server that
// advertises `household_members`: an older server is never called, and a write to it
// rejects with a CapabilityError (CROSS-REPO §15). The provider is mocked to resolve
// each connection id to its own stub client (no id = 'c1').
const evie: HouseholdMember = householdMember({ devices: 1 });
const ellis: HouseholdMember = { ...evie, id: 13, name: 'Ellis', username: 'ellis' };
const list: HouseholdMembers = { allowed: true, max: 6, members: [evie, ellis] };

function makeClient() {
  return {
    serverInfo: jest.fn(),
    members: jest.fn(async () => list),
    memberDevices: jest.fn(async () => []),
    addMember: jest.fn(async (): Promise<object> => ({ member: evie })),
    memberSession: jest.fn(async () => ({ token: 't', server_id: 's', user: { id: 12 } })),
    memberPairing: jest.fn(async () => ({ pairing_token: 'pt' })),
    revokeMemberDevice: jest.fn(async () => undefined),
    updateMember: jest.fn(async (id: number, body: object) => ({ ...evie, id, ...body })),
    deleteMember: jest.fn(async () => undefined),
    revokeMyDevice: jest.fn(async (): Promise<object> => ({ current: false })),
  };
}
type StubClient = ReturnType<typeof makeClient>;
const mockClients: Record<string, StubClient> = {};
/** The app's query client, as `removeConnection`'s hook in hooks.ts reaches it. */
let mockQueryClient: QueryClient | undefined;
jest.mock('@/api/provider', () => ({
  get queryClient() {
    return mockQueryClient;
  },
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
import {
  CapabilityError,
  qk,
  useAddMember,
  useCapability,
  useDeleteMember,
  useHouseholdMembers,
  useMemberDevices,
  useMemberPairing,
  useMemberSession,
  useRevokeMemberDevice,
  useRevokeMyDevice,
  useUpdateMember,
} from '@/api/hooks';
import { noteError } from '@/api/reachability';
import { type Connection, useSession } from '@/stores/session';
/* eslint-enable import/first */

function serverWith(id: string, caps: Partial<Capabilities>): ServerInfo {
  return {
    name: 'S',
    server_id: id,
    version: '1.0.0',
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

async function mount<T>(caps: Partial<Capabilities> | 'pending', useHooks: () => T) {
  mockClients.c1 = makeClient();
  if (caps === 'pending') mockClients.c1.serverInfo.mockReturnValue(new Promise(() => {}));
  else mockClients.c1.serverInfo.mockResolvedValue(serverWith('c1', caps));
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
  for (const id of Object.keys(mockClients)) delete mockClients[id];
  jest.clearAllMocks();
});

const ON: Partial<Capabilities> = { household_members: true, my_devices: true };

type MutationCase = {
  name: string;
  useHook: () => { mutateAsync: (vars: never) => Promise<unknown> };
  vars: unknown;
  method: keyof StubClient;
  args: unknown[];
};
const mutationCases: MutationCase[] = [
  {
    name: 'useAddMember',
    useHook: useAddMember,
    vars: { name: 'Evie', kind: 'kid', access: 'all' },
    method: 'addMember',
    args: [{ name: 'Evie', kind: 'kid', access: 'all' }],
  },
  {
    name: 'useMemberSession',
    useHook: useMemberSession,
    vars: 12,
    method: 'memberSession',
    args: [12],
  },
  {
    name: 'useMemberPairing',
    useHook: useMemberPairing,
    vars: 13,
    method: 'memberPairing',
    args: [13],
  },
  {
    name: 'useRevokeMemberDevice',
    useHook: useRevokeMemberDevice,
    vars: { id: 12, deviceId: 21 },
    method: 'revokeMemberDevice',
    args: [12, 21],
  },
  {
    name: 'useUpdateMember',
    useHook: useUpdateMember,
    vars: { id: 12, body: { name: 'Evie B' } },
    method: 'updateMember',
    args: [12, { name: 'Evie B' }],
  },
  {
    name: 'useDeleteMember',
    useHook: useDeleteMember,
    vars: 12,
    method: 'deleteMember',
    args: [12],
  },
];

async function run(m: { mutateAsync: (vars: never) => Promise<unknown> }, vars: unknown) {
  let error: unknown;
  let answer: unknown;
  await act(async () => {
    answer = await m.mutateAsync(vars as never).catch((e: unknown) => (error = e));
  });
  return { error, answer };
}

describe('household member queries', () => {
  it('ask nothing, even on refetch, of a server without household_members', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = await mount({ household: true, my_devices: true }, () => ({
        members: useHouseholdMembers(),
        devices: useMemberDevices(12),
        known: useCapability('household_members'),
      }));
      await waitFor(() => expect(result.current.known).toBe(false));
      const [a, b] = await act(async () =>
        Promise.all([result.current.members.refetch(), result.current.devices.refetch()]),
      );
      expect(a.isError && b.isError).toBe(true);
      expect(mockClients.c1.members).not.toHaveBeenCalled();
      expect(mockClients.c1.memberDevices).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });

  it('ask a server with household_members, on connection-scoped keys', async () => {
    const { result, qc } = await mount({ household_members: true }, () => ({
      members: useHouseholdMembers(),
      devices: useMemberDevices(12),
    }));
    await waitFor(() => {
      expect(result.current.members.isSuccess).toBe(true);
      expect(result.current.devices.isSuccess).toBe(true);
    });
    expect(result.current.members.data).toEqual(list);
    expect(mockClients.c1.memberDevices).toHaveBeenCalledWith(12, expect.anything());
    expect(qc.getQueryData(qk.householdMembers('c1'))).toEqual(list);
    expect(qc.getQueryData(qk.memberDevices('c1', 12))).toEqual([]);
  });

  it("ask no member's devices while told not to (a member signed in nowhere)", async () => {
    const { result } = await mount({ household_members: true }, () => ({
      none: useMemberDevices(12, undefined, { enabled: false }),
      control: useHouseholdMembers(),
    }));
    await waitFor(() => expect(result.current.control.isSuccess).toBe(true));
    expect(mockClients.c1.memberDevices).not.toHaveBeenCalled();
  });
});

describe('household member writes', () => {
  it.each(mutationCases)(
    '$name rejects with a CapabilityError, sending nothing, without the flag',
    async ({ useHook, vars, method }) => {
      const { result } = await mount({ household: true, my_devices: true }, () => ({
        m: useHook(),
        known: useCapability('household_members'),
      }));
      await waitFor(() => expect(result.current.known).toBe(false));
      const { error } = await run(result.current.m, vars);
      expect(error).toBeInstanceOf(CapabilityError);
      expect(error).toMatchObject({ capability: 'household_members', unknown: false });
      expect(mockClients.c1[method]).not.toHaveBeenCalled();
      expect(noteError).not.toHaveBeenCalled();
    },
  );

  it.each(mutationCases)(
    '$name rejects as unknown while /server is not known',
    async ({ useHook, vars, method }) => {
      const { result } = await mount('pending', () => useHook());
      const { error } = await run(result.current, vars);
      expect(error).toMatchObject({ capability: 'household_members', unknown: true });
      expect(mockClients.c1[method]).not.toHaveBeenCalled();
    },
  );

  it.each(mutationCases)(
    '$name sends to a server with the flag',
    async ({ useHook, vars, method, args }) => {
      const { result } = await mount(ON, () => ({
        m: useHook(),
        known: useCapability('household_members'),
      }));
      await waitFor(() => expect(result.current.known).toBe(true));
      const { error } = await run(result.current.m, vars);
      expect(error).toBeUndefined();
      expect(mockClients.c1[method]).toHaveBeenCalledWith(...args);
    },
  );

  /** Mount `useHook` on a server with the flag, with the members list, Evie's devices
   * and the caller's devices cached. */
  async function mountCached<T>(useHook: () => T) {
    const mounted = await mount(ON, () => ({
      m: useHook(),
      known: useCapability('household_members'),
    }));
    await waitFor(() => expect(mounted.result.current.known).toBe(true));
    mounted.qc.setQueryData(qk.householdMembers('c1'), list);
    mounted.qc.setQueryData(qk.memberDevices('c1', 12), []);
    mounted.qc.setQueryData(qk.memberDevices('c1', 13), []);
    mounted.qc.setQueryData(qk.myDevices('c1'), []);
    mounted.qc.setQueryData(qk.collections('c1'), []);
    mounted.qc.setQueryData(qk.collection('c1', 5), { collection: { id: 5 }, items: [] });
    return mounted;
  }
  const stale = (qc: QueryClient, key: readonly unknown[]) =>
    qc.getQueryState(key)?.isInvalidated === true;

  it('adding refreshes the members list; the caller devices only when signed in here', async () => {
    const { result, qc } = await mountCached(useAddMember);
    await run(result.current.m, { name: 'Ellis', kind: 'grownup', access: 'all' });
    expect(stale(qc, qk.householdMembers('c1'))).toBe(true);
    expect(stale(qc, qk.myDevices('c1'))).toBe(false);

    mockClients.c1.addMember.mockResolvedValueOnce({
      member: evie,
      session: { token: 't', server_id: 's', user: { id: 12 } },
    });
    await run(result.current.m, { name: 'Evie', kind: 'kid', access: 'all', sign_in_here: true });
    expect(stale(qc, qk.myDevices('c1'))).toBe(true);
    expect(stale(qc, qk.collections('c1'))).toBe(false);
  });

  it('adding with collections to share reads the collections again (each lists its people)', async () => {
    const { result, qc } = await mountCached(useAddMember);
    await run(result.current.m, {
      name: 'Evie',
      kind: 'kid',
      access: 'collections',
      collection_ids: [5],
    });
    expect(stale(qc, qk.collections('c1'))).toBe(true);
    // Each detail too: the share sheet saves its `shared_with` back as the full set, so a
    // stale one would take the new member off again.
    expect(stale(qc, qk.collection('c1', 5))).toBe(true);
  });

  it.each([409, 403, 400, 500])(
    'a refused add (%i) still reads the members list again (the cap or the switch moved)',
    async (status) => {
      const { result, qc } = await mountCached(useAddMember);
      mockClients.c1.addMember.mockRejectedValueOnce(new ApiError(status, 'nope'));
      const { error } = await run(result.current.m, {
        name: 'Ellis',
        kind: 'grownup',
        access: 'all',
      });
      expect(error).toMatchObject({ status });
      expect(stale(qc, qk.householdMembers('c1'))).toBe(true);
      expect(stale(qc, qk.myDevices('c1'))).toBe(false);
    },
  );

  it("a member session refreshes the list, that member's devices and the caller's", async () => {
    const { result, qc } = await mountCached(useMemberSession);
    await run(result.current.m, 12);
    expect(stale(qc, qk.householdMembers('c1'))).toBe(true);
    expect(stale(qc, qk.memberDevices('c1', 12))).toBe(true);
    expect(stale(qc, qk.memberDevices('c1', 13))).toBe(false);
    expect(stale(qc, qk.myDevices('c1'))).toBe(true);
  });

  it('a pairing changes nothing cached', async () => {
    const { result, qc } = await mountCached(useMemberPairing);
    await run(result.current.m, 12);
    expect(stale(qc, qk.householdMembers('c1'))).toBe(false);
    expect(stale(qc, qk.myDevices('c1'))).toBe(false);
  });

  it.each([
    { name: 'a session', useHook: useMemberSession, method: 'memberSession', vars: 12 },
    { name: 'a pairing', useHook: useMemberPairing, method: 'memberPairing', vars: 12 },
    {
      name: 'a change',
      useHook: useUpdateMember,
      method: 'updateMember',
      vars: { id: 12, body: { name: 'Evie B' } },
    },
  ] as const)(
    '$name the server refuses (404: deleted elsewhere) reads the members list again',
    async ({ useHook, method, vars }) => {
      const { result, qc } = await mountCached(
        useHook as () => { mutateAsync: (vars: never) => Promise<unknown> },
      );
      (mockClients.c1[method] as jest.Mock).mockRejectedValueOnce(
        new ApiError(404, 'member not found'),
      );
      const { error } = await run(result.current.m, vars);
      expect(error).toMatchObject({ status: 404 });
      expect(stale(qc, qk.householdMembers('c1'))).toBe(true);
      expect(qc.getQueryData<HouseholdMembers>(qk.householdMembers('c1'))).toEqual(list);
    },
  );

  it("signing a member out of a device refreshes that member's devices, the list and the caller's", async () => {
    const { result, qc } = await mountCached(useRevokeMemberDevice);
    await run(result.current.m, { id: 12, deviceId: 21 });
    expect(stale(qc, qk.memberDevices('c1', 12))).toBe(true);
    expect(stale(qc, qk.memberDevices('c1', 13))).toBe(false);
    expect(stale(qc, qk.householdMembers('c1'))).toBe(true);
    expect(stale(qc, qk.myDevices('c1'))).toBe(true);
  });

  it('a sign-out the server refuses (404: signed out already) still refreshes the lists', async () => {
    const { result, qc } = await mountCached(useRevokeMemberDevice);
    mockClients.c1.revokeMemberDevice.mockRejectedValueOnce(new ApiError(404, 'device not found'));
    const { error } = await run(result.current.m, { id: 12, deviceId: 21 });
    expect(error).toMatchObject({ status: 404 });
    expect(stale(qc, qk.memberDevices('c1', 12))).toBe(true);
    expect(stale(qc, qk.memberDevices('c1', 13))).toBe(false);
    expect(stale(qc, qk.householdMembers('c1'))).toBe(true);
    expect(stale(qc, qk.myDevices('c1'))).toBe(true);
  });

  it('a change puts the answer in the list, which needs no second read', async () => {
    const { result, qc } = await mountCached(useUpdateMember);
    const { answer } = await run(result.current.m, { id: 12, body: { name: 'Evie B' } });
    expect(answer).toMatchObject({ id: 12, name: 'Evie B' });
    const cached = qc.getQueryData<HouseholdMembers>(qk.householdMembers('c1'));
    expect(cached?.members.map((m) => m.name)).toEqual(['Evie B', 'Ellis']);
    // The answer is the member as the server has them now.
    expect(stale(qc, qk.householdMembers('c1'))).toBe(false);
    expect(stale(qc, qk.memberDevices('c1', 12))).toBe(false);
    expect(stale(qc, qk.collections('c1'))).toBe(false);
  });

  it('making them a kid reads their devices and the list again (their API keys go)', async () => {
    const { result, qc } = await mountCached(useUpdateMember);
    await run(result.current.m, { id: 12, body: { kind: 'kid' } });
    expect(stale(qc, qk.householdMembers('c1'))).toBe(true);
    expect(stale(qc, qk.memberDevices('c1', 12))).toBe(true);
    expect(stale(qc, qk.memberDevices('c1', 13))).toBe(false);
  });

  it('a change of what is shared with them reads the collections again', async () => {
    const { result, qc } = await mountCached(useUpdateMember);
    await run(result.current.m, { id: 12, body: { access: 'collections', collection_ids: [] } });
    expect(stale(qc, qk.collections('c1'))).toBe(true);
    expect(stale(qc, qk.collection('c1', 5))).toBe(true);
    expect(stale(qc, qk.memberDevices('c1', 12))).toBe(false);
  });

  it('a delete takes the member off the list at once and forgets their devices', async () => {
    const { result, qc } = await mountCached(useDeleteMember);
    await run(result.current.m, 12);
    const cached = qc.getQueryData<HouseholdMembers>(qk.householdMembers('c1'));
    expect(cached?.members.map((m) => m.id)).toEqual([13]);
    // The list just taken them off needs no second read.
    expect(stale(qc, qk.householdMembers('c1'))).toBe(false);
    expect(qc.getQueryState(qk.memberDevices('c1', 12))).toBeUndefined();
    expect(qc.getQueryState(qk.memberDevices('c1', 13))).toBeDefined();
    expect(stale(qc, qk.myDevices('c1'))).toBe(true);
    // The shares with them went with the account: the collections list them no more.
    expect(stale(qc, qk.collections('c1'))).toBe(true);
    expect(stale(qc, qk.collection('c1', 5))).toBe(true);
  });

  it('a refused delete (404: deleted already, elsewhere) reads the list again', async () => {
    const { result, qc } = await mountCached(useDeleteMember);
    mockClients.c1.deleteMember.mockRejectedValueOnce(new ApiError(404, 'member not found'));
    const { error } = await run(result.current.m, 12);
    expect(error).toMatchObject({ status: 404 });
    expect(stale(qc, qk.householdMembers('c1'))).toBe(true);
    expect(qc.getQueryData<HouseholdMembers>(qk.householdMembers('c1'))).toEqual(list);
  });
});

describe('useRevokeMyDevice and alsoMembers', () => {
  async function mountRevoke(caps: Partial<Capabilities>) {
    const mounted = await mount(caps, () => ({
      m: useRevokeMyDevice(),
      known: useCapability('my_devices'),
    }));
    await waitFor(() => expect(mounted.result.current.known).toBe(true));
    return mounted;
  }

  it('keeps the old call: without alsoMembers it sends the id alone', async () => {
    const { result } = await mountRevoke(ON);
    await run(result.current.m, { id: 11 });
    expect(mockClients.c1.revokeMyDevice).toHaveBeenCalledWith(11);
    expect(mockClients.c1.revokeMyDevice.mock.calls[0]).toHaveLength(1);
  });

  it('sends alsoMembers to a server with household_members', async () => {
    const { result, qc } = await mountRevoke(ON);
    qc.setQueryData(qk.householdMembers('c1'), list);
    qc.setQueryData(qk.memberDevices('c1', 12), []);
    mockClients.c1.revokeMyDevice.mockResolvedValueOnce({ current: false, members_signed_out: 1 });
    const { answer } = await run(result.current.m, { id: 11, alsoMembers: true });
    expect(answer).toEqual({ current: false, members_signed_out: 1 });
    expect(mockClients.c1.revokeMyDevice).toHaveBeenCalledWith(11, { alsoMembers: true });
    // Members were signed out: their list and devices are read again.
    expect(qc.getQueryState(qk.householdMembers('c1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.memberDevices('c1', 12))?.isInvalidated).toBe(true);
  });

  it('leaves the members alone when none were signed out', async () => {
    const { result, qc } = await mountRevoke(ON);
    qc.setQueryData(qk.householdMembers('c1'), list);
    await run(result.current.m, { id: 11, alsoMembers: false });
    expect(mockClients.c1.revokeMyDevice).toHaveBeenCalledWith(11);
    expect(qc.getQueryState(qk.householdMembers('c1'))?.isInvalidated).toBe(false);
  });

  it('never sends alsoMembers to a server without household_members', async () => {
    const { result } = await mountRevoke({ my_devices: true });
    await run(result.current.m, { id: 11, alsoMembers: true });
    expect(mockClients.c1.revokeMyDevice).toHaveBeenCalledWith(11);
    expect(mockClients.c1.revokeMyDevice.mock.calls[0]).toHaveLength(1);
  });
});

describe('a connection removed from this device', () => {
  const conn = (id: string, serverId: string, userId: number) =>
    ({
      id,
      serverId,
      name: 'S',
      serverUrl: 'u',
      token: 't',
      user: { id: userId, username: `u${userId}` },
    }) as unknown as Connection;

  // Any way out (signed out on their account page, removed from the Household page or
  // "Who's listening?"): the owner's lists of who is signed in here are read again.
  it('reads the household again on every other connection here on its server', async () => {
    const qc = new QueryClient();
    mockQueryClient = qc;
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    useSession.setState({
      connections: [conn('a.1', 'a', 1), conn('a.12', 'a', 12), conn('b.3', 'b', 3)],
      defaultConnectionId: 'a.1',
    });
    await useSession.getState().removeConnection('a.12');
    const keys = invalidate.mock.calls.map(([f]) => (f as { queryKey?: unknown }).queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        qk.householdMembers('a.1'),
        qk.memberDevicesAll('a.1'),
        qk.myDevices('a.1'),
      ]),
    );
    // Another server's household is not theirs.
    expect(keys.some((k) => (k as unknown[]).includes('b.3'))).toBe(false);
    mockQueryClient = undefined;
  });
});
