import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { BridgeEstimate, BridgeJob, BridgeJobRequest, ServerInfo, User } from '@/api/types';

// "Generate characters and recaps" end to end over the real hooks, against a stand-in
// client: who sees it, the confirmation's estimate, the order books are queued in, and the
// job's status (Cancel, Try again, a park). The provider resolves 'c1' to the stand-in.
const mockServerInfo = jest.fn<Promise<ServerInfo>, []>();
const mockBridgeJobs = jest.fn<Promise<BridgeJob[]>, [number, string]>();
const mockEstimate = jest.fn<Promise<BridgeEstimate>, [number, string, string]>();
const mockQueue = jest.fn<Promise<BridgeJob>, [BridgeJobRequest]>();
const mockCancel = jest.fn<Promise<BridgeJob>, [number]>();
jest.mock('@/api/provider', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({
    c1: {
      serverInfo: () => mockServerInfo(),
      bridgeJobs: (lib: number, path: string) => mockBridgeJobs(lib, path),
      bridgeEstimate: (lib: number, path: string, kind: string) => mockEstimate(lib, path, kind),
      queueBridgeJob: (job: BridgeJobRequest) => mockQueue(job),
      cancelBridgeJob: (id: number) => mockCancel(id),
    },
  }),
);
jest.mock('@/api/reachability', () => ({ noteError: jest.fn() }));
jest.mock('@/playback/progress-sync', () => ({
  mirroredProgress: jest.fn(async () => null),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (t: unknown) => mockToast(t) }));

/* eslint-disable import/first */
import { useSession } from '@/stores/session';
import { ADMIN, bridgeEstimate, bridgeJob, bridgeServer } from '@/testing/bridge-fixtures';
import { notifyQueriesSynchronously } from '@/testing/query-notify';
import { mountWithPortal } from '@/testing/render-overlay';

import type { GenerateContent } from './bridge-model';
import { GenerateOffer } from './generate-offer';
/* eslint-enable import/first */

notifyQueriesSynchronously();

const TARGET = { connectionId: 'c1', libraryId: 1, path: 'Saga/Book 3' };
const EARLIER = [
  { library_id: 1, path: 'Saga/Book 1', title: 'The First', series_index: '1' },
  { library_id: 1, path: 'Saga/Book 2', title: 'The Second', series_index: '2' },
];

function signIn(user: User) {
  useSession.setState({
    connections: [{ id: 'c1', name: 'Hearthside', serverUrl: 'https://h', token: 't', user }],
  } as never);
}

const queryClients: QueryClient[] = [];

async function mount(content?: GenerateContent) {
  // No cache timers left behind: every entry is cleared after each test instead.
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  queryClients.push(qc);
  await mountWithPortal(
    <QueryClientProvider client={qc}>
      <GenerateOffer target={TARGET} content={content} metaKnown title="The Third" />
    </QueryClientProvider>,
  );
  return qc;
}

afterEach(() => {
  for (const qc of queryClients.splice(0)) qc.clear();
});

let nextId = 10;
beforeEach(() => {
  jest.clearAllMocks();
  signIn(ADMIN);
  mockServerInfo.mockResolvedValue(bridgeServer());
  mockBridgeJobs.mockResolvedValue([]);
  mockEstimate.mockResolvedValue(bridgeEstimate({ path: TARGET.path, earlier: EARLIER }));
  mockQueue.mockImplementation(async (job) =>
    bridgeJob({ id: nextId++, state: 'queued', library_id: job.library_id, path: job.path }),
  );
});

describe('who sees "Generate characters and recaps"', () => {
  it('offers it to an admin for a book with no characters or recaps', async () => {
    await mount();
    expect(await screen.findByTestId('generate-action')).toBeTruthy();
    expect(mockBridgeJobs).toHaveBeenCalledWith(1, 'Saga/Book 3');
  });

  it('hides it from a non-admin, and never asks for their jobs', async () => {
    signIn({ ...ADMIN, role: 'user' });
    await mount();
    await waitFor(() => expect(mockServerInfo).toHaveBeenCalled());
    expect(screen.queryByTestId('generate-action')).toBeNull();
    expect(mockBridgeJobs).not.toHaveBeenCalled();
  });

  it('hides it on an older server without the bridge flag', async () => {
    const old = bridgeServer();
    mockServerInfo.mockResolvedValue({
      ...old,
      capabilities: { ...old.capabilities, bridge: undefined },
      bridge: undefined,
    });
    await mount();
    await waitFor(() => expect(mockServerInfo).toHaveBeenCalled());
    expect(screen.queryByTestId('generate-action')).toBeNull();
    expect(mockBridgeJobs).not.toHaveBeenCalled();
  });

  it('offers nothing for a book that has characters or recaps already', async () => {
    await mount({ recaps: [{}] });
    await waitFor(() => expect(mockBridgeJobs).toHaveBeenCalled());
    expect(screen.queryByTestId('generate-action')).toBeNull();
  });
});

describe('the confirmation', () => {
  it('shows the estimate, then queues the earlier books first, in order, then this one', async () => {
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    expect(await screen.findByTestId('generate-estimate')).toBeTruthy();
    expect(mockEstimate).toHaveBeenCalledWith(1, 'Saga/Book 3', 'sidecars.generate');
    expect(screen.getByText('The audio, transcribed first')).toBeTruthy();
    expect(screen.getByText('About 2h 30m')).toBeTruthy();
    expect(screen.getByText('About $16.00')).toBeTruthy();
    expect(screen.getByText('On this server')).toBeTruthy();
    expect(screen.getByText('Also generate for 2 earlier books first')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('generate-confirm'));
    await waitFor(() => expect(mockQueue).toHaveBeenCalledTimes(3));
    expect(mockQueue.mock.calls.map(([j]) => j)).toEqual(
      ['Saga/Book 1', 'Saga/Book 2', 'Saga/Book 3'].map((path) => ({
        kind: 'sidecars.generate',
        library_id: 1,
        path,
        params: { source: 'auto', contribute: 'local' },
      })),
    );
    expect(mockToast).toHaveBeenLastCalledWith({ title: 'Queued 3 books, earliest first.' });
  });

  it('queues only this book with the earlier-books switch off', async () => {
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    await fireEvent(await screen.findByTestId('generate-earlier'), 'checkedChange', false);
    await fireEvent.press(screen.getByTestId('generate-confirm'));
    await waitFor(() => expect(mockQueue).toHaveBeenCalledTimes(1));
    expect(mockQueue.mock.calls[0][0].path).toBe('Saga/Book 3');
  });

  it('says what it reads for an ebook, and that no estimate exists yet', async () => {
    mockEstimate.mockResolvedValue(
      bridgeEstimate({
        source: 'ebook',
        ebook: 'Saga/Book 3/The Third.epub',
        asr_hours: 0,
        agent_cost_usd: null,
        subscription: true,
      }),
    );
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    expect(await screen.findByText('The ebook, The Third.epub')).toBeTruthy();
    expect(screen.getByText('No transcription needed')).toBeTruthy();
    expect(screen.getByText('No estimate yet')).toBeTruthy();
    expect(screen.getByText(/runs on a subscription/)).toBeTruthy();
    expect(screen.queryByTestId('generate-earlier')).toBeNull();
  });

  it('holds Generate back, saying why, when the Bridge cannot write the library', async () => {
    mockEstimate.mockResolvedValue(bridgeEstimate({ writable: false }));
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    expect(await screen.findByTestId('generate-blocked')).toBeTruthy();
    expect(screen.getByText(/can't write to this library/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('generate-confirm'));
    expect(mockQueue).not.toHaveBeenCalled();
  });

  it("holds it back when the Bridge's agent isn't ready", async () => {
    mockEstimate.mockResolvedValue(bridgeEstimate({ agent_ready: false }));
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    expect(await screen.findByText(/AI agent isn't ready/)).toBeTruthy();
  });
});

describe('the status while a job runs', () => {
  it('shows the stage, the counts and the time left, and cancels', async () => {
    const running = bridgeJob({
      id: 7,
      path: TARGET.path,
      progress: { step: 'asr', done: 12, total: 40, eta_seconds: 5400 },
    });
    mockBridgeJobs.mockResolvedValue([running]);
    mockCancel.mockResolvedValue({ ...running, cancel_requested: true });
    await mount();
    expect(await screen.findByText('Transcribing · 12 of 40 · about 1h 30m left')).toBeTruthy();
    expect(screen.queryByTestId('generate-action')).toBeNull();
    await fireEvent.press(screen.getByTestId('generate-cancel'));
    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith(7));
    expect(await screen.findByText('Stopping')).toBeTruthy();
  });

  it('says why a parked job stopped, and to open the console', async () => {
    mockBridgeJobs.mockResolvedValue([
      bridgeJob({
        state: 'needs_attention',
        error: 'budget exceeded',
        progress: { step: 'synthesizing', park: { code: 'budget_exceeded' } },
      }),
    ]);
    await mount();
    expect(await screen.findByText('Generating is paused')).toBeTruthy();
    expect(screen.getByText('The Bridge reached its spending limit.')).toBeTruthy();
    expect(screen.getByText('Open the console to fix it.')).toBeTruthy();
  });

  it('shows a failure with its error, and Try again queues this book again', async () => {
    mockBridgeJobs.mockResolvedValue([
      bridgeJob({ state: 'failed', path: TARGET.path, error: 'agent output failed validation' }),
    ]);
    await mount();
    expect(await screen.findByText('Generating failed')).toBeTruthy();
    expect(screen.getByText('agent output failed validation')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('generate-retry'));
    await waitFor(() => expect(mockQueue).toHaveBeenCalledTimes(1));
    expect(mockQueue.mock.calls[0][0]).toMatchObject({ path: 'Saga/Book 3' });
  });
});
