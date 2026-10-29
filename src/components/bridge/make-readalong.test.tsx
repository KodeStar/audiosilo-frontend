import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { BridgeJob, BridgeJobRequest, ReadalongEstimate, ServerInfo, User } from '@/api/types';

// "Make read-along" end to end over the real hooks, against a stand-in client: who sees
// it, the confirmation's estimate and its holds, the queued job, its status.
const mockServerInfo = jest.fn<Promise<ServerInfo>, []>();
const mockBridgeJobs = jest.fn<Promise<BridgeJob[]>, [number, string]>();
const mockEstimate = jest.fn<Promise<ReadalongEstimate>, [number, string]>();
const mockQueue = jest.fn<Promise<BridgeJob>, [BridgeJobRequest]>();
jest.mock('@/api/provider', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({
    c1: {
      serverInfo: () => mockServerInfo(),
      bridgeJobs: (lib: number, path: string) => mockBridgeJobs(lib, path),
      readalongEstimate: (lib: number, path: string) => mockEstimate(lib, path),
      queueBridgeJob: (job: BridgeJobRequest) => mockQueue(job),
      cancelBridgeJob: jest.fn(),
    },
  }),
);
jest.mock('@/api/reachability', () => ({ noteFailure: jest.fn() }));
jest.mock('@/playback/progress-sync', () => ({
  mirroredProgress: jest.fn(async () => null),
  saveProgress: jest.fn(async () => {}),
  getDeviceId: jest.fn(async () => 'dev-1'),
}));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (t: unknown) => mockToast(t) }));
jest.mock('expo-router', () => ({ useIsFocused: () => true }));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';
import { READALONG_ALIGN } from '@/lib/bridge-jobs';
import { useSession } from '@/stores/session';
import { ADMIN, bridgeJob, bridgeServer } from '@/testing/bridge-fixtures';
import { notifyQueriesSynchronously } from '@/testing/query-notify';
import { mountWithPortal } from '@/testing/render-overlay';

import { MakeReadalongOffer } from './make-readalong';
/* eslint-enable import/first */

notifyQueriesSynchronously();

const TARGET = { connectionId: 'c1', libraryId: 1, path: 'London/Call of the Wild' };
const SERVER = bridgeServer({
  capabilities: { ...bridgeServer().capabilities, readalong: true },
  bridge: { version: '0.5.0', features: ['sidecars', 'readalong'] },
});

const estimate = (over: Partial<ReadalongEstimate> = {}): ReadalongEstimate => ({
  kind: READALONG_ALIGN,
  asr_hours: 3.5,
  figures: true,
  writable: true,
  ebook: { path: 'London/Call of the Wild/call.epub', size: 9 },
  readalong: null,
  ...over,
});

function signIn(user: User) {
  useSession.setState({
    connections: [{ id: 'c1', name: 'Hearthside', serverUrl: 'https://h', token: 't', user }],
  } as never);
}

const queryClients: QueryClient[] = [];
async function mount() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  queryClients.push(qc);
  await mountWithPortal(
    <QueryClientProvider client={qc}>
      <MakeReadalongOffer target={TARGET} hasEbook title="The Call of the Wild" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  for (const qc of queryClients.splice(0)) qc.clear();
});

beforeEach(() => {
  jest.clearAllMocks();
  signIn(ADMIN);
  mockServerInfo.mockResolvedValue(SERVER);
  mockBridgeJobs.mockResolvedValue([]);
  mockEstimate.mockResolvedValue(estimate());
  mockQueue.mockImplementation(async (job) =>
    bridgeJob({ id: 7, kind: job.kind, state: 'queued', library_id: 1, path: job.path }),
  );
});

describe('who sees "Make read-along"', () => {
  it('offers it to an admin whose Bridge makes maps', async () => {
    await mount();
    expect(await screen.findByTestId('readalong-make')).toBeTruthy();
  });

  it('hides it from a non-admin, never asking for their jobs', async () => {
    signIn({ ...ADMIN, role: 'user' });
    await mount();
    await waitFor(() => expect(mockServerInfo).toHaveBeenCalled());
    expect(screen.queryByTestId('readalong-make')).toBeNull();
    expect(mockBridgeJobs).not.toHaveBeenCalled();
  });

  it('hides it where the Bridge does not offer read-along', async () => {
    mockServerInfo.mockResolvedValue(
      bridgeServer({
        capabilities: { ...SERVER.capabilities },
        bridge: { version: '0.4.0', features: ['sidecars'] },
      }),
    );
    await mount();
    await waitFor(() => expect(mockServerInfo).toHaveBeenCalled());
    expect(screen.queryByTestId('readalong-make')).toBeNull();
  });

  it("shows a running job's status in its place", async () => {
    mockBridgeJobs.mockResolvedValue([
      bridgeJob({
        kind: READALONG_ALIGN,
        state: 'running',
        progress: { step: 'readalong_aligning', done: 3, total: 7 },
      }),
    ]);
    await mount();
    expect(await screen.findByText('Making the read-along')).toBeTruthy();
    expect(screen.getByText(/Lining the text up with the narration/)).toBeTruthy();
    expect(screen.queryByTestId('readalong-make')).toBeNull();
  });
});

describe('the confirmation', () => {
  const open = async () => {
    await mount();
    await fireEvent.press(await screen.findByTestId('readalong-make'));
    await screen.findByTestId('readalong-estimate');
  };

  it('quotes the ebook, the most transcription and no agent, and queues the job', async () => {
    await open();
    expect(screen.getByText('The ebook, call.epub, and the audio')).toBeTruthy();
    expect(screen.getByText(/^Up to /)).toBeTruthy();
    expect(screen.getByText('None: no AI agent is used')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('readalong-confirm'));
    await waitFor(() =>
      expect(mockQueue).toHaveBeenCalledWith({
        kind: READALONG_ALIGN,
        library_id: 1,
        path: TARGET.path,
        params: {},
      }),
    );
    expect(mockToast).toHaveBeenCalledWith({
      title: "Queued. The text appears here when it's done.",
    });
  });

  it.each([
    [{ ebook: null }, 'This book has no ebook to line up with its narration.'],
    [{ writable: false }, /can't write to this library/],
    [
      { open_job: bridgeJob({ kind: 'sidecars.generate', state: 'queued' }) },
      /characters and recaps are being generated/,
    ],
    [
      { open_job: bridgeJob({ kind: 'chapters.detect', state: 'running' }) },
      /chapters are still being found/,
    ],
    [
      { open_job: bridgeJob({ kind: READALONG_ALIGN, state: 'queued' }) },
      "This book's read-along is already being made.",
    ],
  ] as const)('holds Make back on %j', async (over, words) => {
    mockEstimate.mockResolvedValue(estimate(over));
    await open();
    expect(screen.getByTestId('readalong-blocked')).toHaveTextContent(words);
    expect(screen.getByTestId('readalong-confirm')).toBeDisabled();
  });

  it('says a refusal in its own words, keeping the confirmation open', async () => {
    mockQueue.mockRejectedValue(new ApiError(409, 'busy', 'detect_open'));
    await open();
    await fireEvent.press(screen.getByTestId('readalong-confirm'));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: expect.stringMatching(/chapters are still being found/),
      }),
    );
    expect(screen.getByTestId('readalong-confirm')).toBeTruthy();
  });
});
