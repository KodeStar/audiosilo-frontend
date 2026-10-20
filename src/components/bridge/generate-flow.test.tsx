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
// The status polls while its screen is focused; these mount it with no navigator.
jest.mock('expo-router', () => ({ useIsFocused: () => true }));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';
import { qk } from '@/api/hooks';
import { useSession } from '@/stores/session';
import { ADMIN, bridgeEstimate, bridgeJob, bridgeServer } from '@/testing/bridge-fixtures';
import { notifyQueriesSynchronously } from '@/testing/query-notify';
import { mountWithPortal } from '@/testing/render-overlay';

import type { GenerateContent } from './bridge-model';
import { GenerateCovered } from './generate-covered';
import { GenerateOffer } from './generate-offer';
import { GenerateStatus } from './generate-status';
import type { GenerateModel } from './use-generate';
/* eslint-enable import/first */

notifyQueriesSynchronously();

const TARGET = { connectionId: 'c1', libraryId: 1, path: 'Saga/Book 3' };
// Each earlier book's own figures (1h 30m of transcription, $10), as the server sends them.
const EARLIER = [
  {
    library_id: 1,
    path: 'Saga/Book 1',
    title: 'The First',
    series_index: '1',
    asr_hours: 1.5,
    agent_cost_usd: 10,
  },
  {
    library_id: 1,
    path: 'Saga/Book 2',
    title: 'The Second',
    series_index: '2',
    asr_hours: 1.5,
    agent_cost_usd: 10,
  },
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

  // Bridge Phase 1e: Generate is offered while the community lacks either half.
  it('offers it for a book the community has only recaps for', async () => {
    await mount({ recaps: [{}] });
    expect(await screen.findByTestId('generate-action')).toBeTruthy();
    expect(screen.queryByTestId('generate-covered')).toBeNull();
  });

  // The companion never shows the covered line (an empty panel means the community lacks
  // that half); the book page does.
  it('offers nothing for a book the community has both for', async () => {
    const qc = await mount({ characters: [{}], recaps: [{}] });
    // Once the jobs have answered (until then nothing is offered anyway).
    await waitFor(() =>
      expect(qc.getQueryState(qk.bridgeJobs('c1', 1, TARGET.path))?.status).toBe('success'),
    );
    expect(screen.queryByTestId('generate-action')).toBeNull();
    expect(screen.queryByTestId('generate-covered')).toBeNull();
  });
});

describe('the covered line', () => {
  it('opens the characters from its link', async () => {
    const onOpen = jest.fn();
    await mountWithPortal(<GenerateCovered onOpen={onOpen} />);
    await fireEvent.press(screen.getByTestId('generate-covered-open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('the confirmation', () => {
  it('shows the estimate, then queues the earlier books first, in order, then this one', async () => {
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    expect(await screen.findByTestId('generate-estimate')).toBeTruthy();
    expect(mockEstimate).toHaveBeenCalledWith(1, 'Saga/Book 3', 'sidecars.generate');
    expect(screen.getByText('The audio, transcribed first')).toBeTruthy();
    // The figures quote all three runs the button queues (2h 30m and $16 for this book,
    // 1h 30m and $10 for each earlier one).
    expect(screen.getByText('About 5h 30m for 3 books')).toBeTruthy();
    expect(screen.getByText('About $36.00 for 3 books')).toBeTruthy();
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

  // This book is queued last: a refusal part-way leaves it out, so the confirmation stays
  // open to press again (the books already queued answer with their open job).
  it('says why it stopped part-way, and keeps the confirmation open to press again', async () => {
    mockQueue.mockImplementation(async (job) => {
      if (job.path === 'Saga/Book 2') throw new ApiError(500, 'could not queue');
      return bridgeJob({
        id: nextId++,
        state: 'queued',
        library_id: job.library_id,
        path: job.path,
      });
    });
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    expect(await screen.findByTestId('generate-estimate')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('generate-confirm'));
    await waitFor(() =>
      expect(mockToast).toHaveBeenLastCalledWith({
        title: "Queued 1 of 3 books. The rest couldn't be queued.",
        description: "This book isn't queued yet. Press Generate again to queue the rest.",
      }),
    );
    expect(mockQueue.mock.calls.map(([j]) => j.path)).toEqual(['Saga/Book 1', 'Saga/Book 2']);
    expect(screen.getByTestId('generate-estimate')).toBeTruthy();
  });

  it('queues only this book with the earlier-books switch off, quoting it alone', async () => {
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    await fireEvent(await screen.findByTestId('generate-earlier'), 'checkedChange', false);
    expect(screen.getByText('About 2h 30m')).toBeTruthy();
    expect(screen.getByText('About $16.00')).toBeTruthy();
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

  // Bridge Phase 1d: while a chapters.detect job is queued or working for the book the
  // server refuses a generate job (409 detect_open), and the estimate names it as open_job.
  it("holds it back while the book's chapters are still being found", async () => {
    mockEstimate.mockResolvedValue(
      bridgeEstimate({ open_job: bridgeJob({ kind: 'chapters.detect', state: 'running' }) }),
    );
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    expect(await screen.findByTestId('generate-blocked')).toBeTruthy();
    expect(screen.getByText(/chapters are still being found/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('generate-confirm'));
    expect(mockQueue).not.toHaveBeenCalled();
  });

  // A detection queued after the estimate was read: the server's refusal says why.
  it('says why when the server refuses it for a detection still open', async () => {
    mockEstimate.mockResolvedValue(bridgeEstimate({ path: TARGET.path }));
    mockQueue.mockRejectedValue(new ApiError(409, 'refused', 'detect_open'));
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    expect(await screen.findByTestId('generate-estimate')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('generate-confirm'));
    await waitFor(() =>
      expect(mockToast).toHaveBeenLastCalledWith({
        title:
          "The book's chapters are still being found. Generate once that has finished: it reuses the transcription.",
      }),
    );
  });

  // Bridge Phase 2b: while the console shares the book's characters and recaps (a
  // sidecars.contribute job queued or working) the server refuses a generate job (409
  // contribute_open), and the estimate names it as open_job.
  it("holds it back while the book's characters and recaps are being shared", async () => {
    mockEstimate.mockResolvedValue(
      bridgeEstimate({ open_job: bridgeJob({ kind: 'sidecars.contribute', state: 'running' }) }),
    );
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    expect(await screen.findByTestId('generate-blocked')).toBeTruthy();
    expect(screen.getByText(/being shared with the community/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('generate-confirm'));
    expect(mockQueue).not.toHaveBeenCalled();
  });

  // A share queued after the estimate was read: the server's refusal says why.
  it('says why when the server refuses it for a share still open', async () => {
    mockEstimate.mockResolvedValue(bridgeEstimate({ path: TARGET.path }));
    mockQueue.mockRejectedValue(new ApiError(409, 'refused', 'contribute_open'));
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    expect(await screen.findByTestId('generate-estimate')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('generate-confirm'));
    await waitFor(() =>
      expect(mockToast).toHaveBeenLastCalledWith({
        title:
          "This book's characters and recaps are being shared with the community. Generate once that has finished.",
      }),
    );
  });

  // A Bridge that sent no figures: its agent_ready is only a default, its transcription
  // time unknown (never "none" for the audio), and the server would queue the job.
  it('holds nothing back, and claims nothing, when the Bridge sent no figures', async () => {
    mockEstimate.mockResolvedValue(
      bridgeEstimate({ figures: false, agent_ready: false, asr_hours: 0, agent_cost_usd: null }),
    );
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    expect(await screen.findByTestId('generate-estimate')).toBeTruthy();
    expect(screen.queryByText(/AI agent isn't ready/)).toBeNull();
    expect(screen.queryByText('No transcription needed')).toBeNull();
    expect(screen.getAllByText('No estimate yet')).toHaveLength(2);
    await fireEvent.press(screen.getByTestId('generate-confirm'));
    await waitFor(() => expect(mockQueue).toHaveBeenCalledTimes(1));
  });

  it('offers Retry when the estimate could not be read', async () => {
    mockEstimate.mockRejectedValueOnce(new Error('offline'));
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-action'));
    expect(await screen.findByText(/Couldn't get an estimate/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('generate-estimate')).toBeTruthy();
    expect(mockEstimate).toHaveBeenCalledTimes(2);
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

  // Bridge Phase 1d: a book with no chapter markers gets its chapters from the narration.
  it('words the chapter detection stage', async () => {
    mockBridgeJobs.mockResolvedValue([bridgeJob({ progress: { stage: 'chapter_detecting' } })]);
    await mount();
    expect(await screen.findByText('Finding the chapters in the narration')).toBeTruthy();
  });

  // No chapter headings were heard with confidence: a person decides what to do.
  it('says the Bridge could not find the chapters, and to open the console', async () => {
    mockBridgeJobs.mockResolvedValue([
      bridgeJob({
        state: 'needs_attention',
        progress: { stage: 'chapter_detecting', park: { code: 'chapters_not_detected' } },
      }),
    ]);
    await mount();
    expect(await screen.findByText('Generating is paused')).toBeTruthy();
    expect(
      screen.getByText("The Bridge couldn't find the chapters in the narration."),
    ).toBeTruthy();
    expect(screen.getByText('Open the console to fix it.')).toBeTruthy();
  });

  // The Bridge takes a book waiting for a worker on once one connects: nothing to fix.
  it('says a job waiting for a worker carries on by itself', async () => {
    mockBridgeJobs.mockResolvedValue([
      bridgeJob({
        state: 'needs_attention',
        progress: { step: 'asr', park: { code: 'asr_worker_waiting' } },
      }),
    ]);
    await mount();
    expect(await screen.findByText('Waiting for a transcription worker to connect.')).toBeTruthy();
    expect(screen.getByText('It carries on by itself.')).toBeTruthy();
    expect(screen.queryByText('Open the console to fix it.')).toBeNull();
  });

  // A spent monthly budget resumes when the month turns: a bare time would read as today.
  it('names the day a park resumes by itself when that is not today', async () => {
    const later = new Date(Date.now() + 3 * 24 * 3600_000);
    mockBridgeJobs.mockResolvedValue([
      bridgeJob({
        state: 'needs_attention',
        progress: { park: { code: 'budget_exceeded', retry_at: later.toISOString() } },
      }),
    ]);
    await mount();
    expect(await screen.findByText(/^It tries again by itself on .+ at .+\.$/)).toBeTruthy();
    expect(screen.queryByText(/^It tries again by itself at /)).toBeNull();
  });

  // The book page renders the status for everyone; once the person may not generate
  // (the Bridge went offline: the flag is off) a cached job could neither move nor be
  // cancelled from here, so it isn't shown.
  it('shows no cached job to someone who may not generate here', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    queryClients.push(qc);
    qc.setQueryData(qk.bridgeJobs('c1', 1, TARGET.path), [bridgeJob({ path: TARGET.path })]);
    const model: GenerateModel = {
      target: TARGET,
      allowed: false,
      offer: null,
      covered: false,
      confirming: false,
      setConfirming: jest.fn(),
      queue: jest.fn(async () => false),
      queueing: false,
      cancel: jest.fn(),
      cancelling: false,
      retry: jest.fn(),
    };
    await mountWithPortal(
      <QueryClientProvider client={qc}>
        <GenerateStatus model={model} />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('generate-status')).toBeNull();
    expect(mockBridgeJobs).not.toHaveBeenCalled();
  });

  it('cancels a job that already ended without saying to try again', async () => {
    const running = bridgeJob({ id: 7, path: TARGET.path });
    mockBridgeJobs.mockResolvedValueOnce([running]);
    mockBridgeJobs.mockResolvedValue([{ ...running, state: 'done' }]);
    mockCancel.mockRejectedValue(new ApiError(409, 'the job has already finished', 'finished'));
    await mount();
    await fireEvent.press(await screen.findByTestId('generate-cancel'));
    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith(7));
    await waitFor(() => expect(screen.queryByTestId('generate-status')).toBeNull());
    expect(mockToast).not.toHaveBeenCalled();
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
