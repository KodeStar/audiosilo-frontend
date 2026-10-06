import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react-native';

import type { Capabilities, ServerInfo } from '@/api/types';

// The capability-gated hooks must never send a request the connected server does not
// advertise (CROSS-REPO §15: shipped clients and older servers coexist). The provider
// is mocked to hand back one stub client; a real QueryClient drives the gating.
const mockClient = {
  serverInfo: jest.fn(),
  authors: jest.fn(async () => ({ people: [], unknown: 0 })),
  narrators: jest.fn(async () => ({ people: [], unknown: 0 })),
  seriesList: jest.fn(async () => []),
  nextBook: jest.fn(async () => ({ source: 'none' })),
};
jest.mock('@/api/provider', () => ({
  useApi: () => mockClient,
  useApis: () => [],
  useCid: () => 'c1',
  useOptionalApi: () => mockClient,
}));
jest.mock('@/api/reachability', () => ({ noteError: jest.fn() }));
jest.mock('@/playback/progress-sync', () => ({
  mirroredProgress: jest.fn(async () => null),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));

/* eslint-disable import/first */
import { useAuthors, useNarrators, useNextBook, useSeriesList } from '@/api/hooks';
/* eslint-enable import/first */

function serverWith(caps: Partial<Capabilities>): ServerInfo {
  return {
    name: 'S',
    server_id: 'c1',
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

async function mount(caps: Partial<Capabilities>, useHooks: () => void) {
  mockClient.serverInfo.mockResolvedValue(serverWith(caps));
  // gcTime Infinity: no garbage-collection timer is left running after the suite.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(qc);
  function Probe() {
    useHooks();
    return null;
  }
  await act(async () => {
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await waitFor(() => expect(mockClient.serverInfo).toHaveBeenCalled());
  return qc;
}

function useBrowseAndNext() {
  useAuthors(2);
  useNarrators(2);
  useSeriesList(2);
  useNextBook(2, 'Saga/Book 2');
}

const clients: QueryClient[] = [];

beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  for (const qc of clients.splice(0)) qc.clear();
});

describe('capability-gated hooks', () => {
  it('sends nothing to a server without browse_people / next_book', async () => {
    const qc = await mount({ metadata: true }, useBrowseAndNext);
    await waitFor(() => expect(qc.isFetching()).toBe(0));
    expect(mockClient.authors).not.toHaveBeenCalled();
    expect(mockClient.narrators).not.toHaveBeenCalled();
    expect(mockClient.seriesList).not.toHaveBeenCalled();
    expect(mockClient.nextBook).not.toHaveBeenCalled();
  });

  it('fetches once the server advertises the capabilities', async () => {
    await mount({ browse_people: true, next_book: true }, useBrowseAndNext);
    await waitFor(() => expect(mockClient.nextBook).toHaveBeenCalled());
    expect(mockClient.authors).toHaveBeenCalledWith(2, expect.anything());
    expect(mockClient.narrators).toHaveBeenCalledWith(2, expect.anything());
    expect(mockClient.seriesList).toHaveBeenCalledWith(2, expect.anything());
    expect(mockClient.nextBook).toHaveBeenCalledWith(2, 'Saga/Book 2', expect.anything());
  });

  it('holds useNextBook while the caller disables it', async () => {
    const qc = await mount({ next_book: true }, () => useNextBook(2, 'Saga/Book 2', false));
    await waitFor(() => expect(qc.isFetching()).toBe(0));
    expect(mockClient.nextBook).not.toHaveBeenCalled();
  });
});
