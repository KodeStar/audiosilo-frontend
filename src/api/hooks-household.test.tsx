import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';

import type { Capabilities, ServerInfo } from '@/api/types';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

// The household hooks (player redesign Phase 8) ask only a server that advertises
// `household`: an older server is never called, and a write to it rejects with a
// CapabilityError (CROSS-REPO §15). The provider is mocked to resolve each connection
// id to its own stub client (no id = 'c1').
function makeClient() {
  return {
    serverInfo: jest.fn(),
    household: jest.fn(async () => ({ share_listening: false })),
    setHousehold: jest.fn(async (share: boolean) => ({ share_listening: share })),
    houseListening: jest.fn(async () => ({ sharing: true, listening: [] })),
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
import {
  CapabilityError,
  HOUSE_POLL_MS,
  housePollInterval,
  qk,
  useCapability,
  useHousehold,
  useHouseListening,
  useSetHousehold,
} from '@/api/hooks';
import { noteError } from '@/api/reachability';
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

describe('household hooks', () => {
  it('ask nothing, even on refetch, of a server without household', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = await mount({ queue: true }, () => ({
        setting: useHousehold(),
        house: useHouseListening(),
        known: useCapability('household'),
      }));
      await waitFor(() => expect(result.current.known).toBe(false));
      const [a, b] = await act(async () =>
        Promise.all([result.current.setting.refetch(), result.current.house.refetch()]),
      );
      expect(a.isError && b.isError).toBe(true);
      expect(mockClients.c1.household).not.toHaveBeenCalled();
      expect(mockClients.c1.houseListening).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });

  it('ask a server with household', async () => {
    const { result, qc } = await mount({ household: true }, () => ({
      setting: useHousehold(),
      house: useHouseListening(),
    }));
    await waitFor(() => {
      expect(result.current.setting.isSuccess).toBe(true);
      expect(result.current.house.isSuccess).toBe(true);
    });
    expect(result.current.setting.data).toEqual({ share_listening: false });
    expect(result.current.house.data).toEqual({ sharing: true, listening: [] });
    // The house polls (every minute in the foreground: housePollInterval).
    const observer = qc.getQueryCache().find({ queryKey: qk.houseListening('c1') })?.observers[0];
    expect(observer?.options.refetchInterval).toBe(housePollInterval);
  });

  it('hold the house while not enabled', async () => {
    const { result } = await mount({ household: true }, () => ({
      held: useHouseListening(undefined, { enabled: false }),
      control: useHousehold(),
    }));
    await waitFor(() => expect(result.current.control.isSuccess).toBe(true));
    expect(mockClients.c1.houseListening).not.toHaveBeenCalled();
  });

  it('a write to a server without household rejects with a CapabilityError, sending nothing', async () => {
    const { result } = await mount({}, () => ({
      m: useSetHousehold(),
      known: useCapability('household'),
    }));
    await waitFor(() => expect(result.current.known).toBe(false));
    let error: unknown;
    await act(async () => {
      await result.current.m.mutateAsync(true).catch((e: unknown) => (error = e));
    });
    expect(error).toBeInstanceOf(CapabilityError);
    expect(error).toMatchObject({ capability: 'household', unknown: false });
    expect(mockClients.c1.setHousehold).not.toHaveBeenCalled();
    expect(noteError).not.toHaveBeenCalled();
  });

  it('a write while /server is unknown rejects as unknown', async () => {
    const { result } = await mount('pending', () => useSetHousehold());
    let error: unknown;
    await act(async () => {
      await result.current.mutateAsync(true).catch((e: unknown) => (error = e));
    });
    expect(error).toMatchObject({ capability: 'household', unknown: true });
    expect(mockClients.c1.setHousehold).not.toHaveBeenCalled();
  });

  it('a write stores its answer and refreshes the house', async () => {
    const { result, qc } = await mount({ household: true }, () => ({
      m: useSetHousehold(),
      known: useCapability('household'),
    }));
    await waitFor(() => expect(result.current.known).toBe(true));
    qc.setQueryData(qk.household('c1'), { share_listening: false });
    qc.setQueryData(qk.houseListening('c1'), { sharing: false, listening: [] });
    await act(async () => {
      await result.current.m.mutateAsync(true);
    });
    expect(mockClients.c1.setHousehold).toHaveBeenCalledWith(true);
    expect(qc.getQueryData(qk.household('c1'))).toEqual({ share_listening: true });
    expect(qc.getQueryState(qk.houseListening('c1'))?.isInvalidated).toBe(true);
  });
});

describe('housePollInterval', () => {
  const original = AppState.currentState;
  afterEach(() => {
    (AppState as { currentState: string }).currentState = original;
  });

  it('polls every minute in the foreground and not at all otherwise', () => {
    (AppState as { currentState: string }).currentState = 'active';
    expect(housePollInterval()).toBe(HOUSE_POLL_MS);
    expect(HOUSE_POLL_MS).toBe(60_000);
    for (const state of ['background', 'inactive']) {
      (AppState as { currentState: string }).currentState = state;
      expect(housePollInterval()).toBe(false);
    }
  });
});
