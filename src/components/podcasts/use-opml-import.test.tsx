import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { MyPodcasts, OpmlImportResult, OpmlImportRow } from '@/api/types';

// The import's wiring (Bridge Phase 2d-2); the wave rules have their own suite
// (opml-waves.test.ts). Here: the local size refusal, what an upload sends, the follow
// requests read through the shared cache entry, the show list read again after a wave,
// the background pause, and nothing more once the page goes.
const mockClient = {
  importOpml: jest.fn(),
  myPodcasts: jest.fn(async (): Promise<MyPodcasts> => ({ shows: [], requests: [] })),
  serverInfo: jest.fn(async () => ({ capabilities: { podcasts: true } })),
  followPodcastByUrl: jest.fn(),
};
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => mockClient,
  useCid: (id?: string) => id ?? 'c1',
}));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
let mockMayAct = true;
jest.mock('@/stores/profiles', () => ({ mayActFor: () => mockMayAct }));
const mockForeground: { fn?: () => void; leave?: () => void; stopped: number } = { stopped: 0 };
jest.mock('@/lib/when-active', () => ({
  onForeground: (fn: () => void, leave: () => void) => {
    mockForeground.fn = fn;
    mockForeground.leave = leave;
    return () => mockForeground.stopped++;
  },
}));

/* eslint-disable import/first */
import { qk } from '@/api/hooks';

import { OPML_MAX_BYTES } from './find-shows-model';
import { useOpmlImport } from './use-opml-import';
import { WAVE_SPACING_MS } from './opml-waves';
/* eslint-enable import/first */

const row = (i: number, status: OpmlImportRow['status']): OpmlImportRow => ({
  outline_index: i,
  status,
  feed: `https://example.com/${i}.xml`,
  private: false,
  path: null,
  request_id: status === 'queued' ? 100 + i : null,
  duplicate_of: null,
  error: null,
});

const answer = (rows: OpmlImportRow[]): OpmlImportResult => ({ library_id: 7, rows });

const file = (size = 10) => ({ name: 'subs.opml', size, body: new Uint8Array(size) });

let qc: QueryClient;
function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useOpmlImport('c1', 7), { wrapper });
}

beforeEach(() => {
  jest.useFakeTimers();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  mockClient.importOpml.mockReset();
  mockClient.followPodcastByUrl.mockReset();
  mockToast.mockReset();
  mockClient.myPodcasts.mockClear();
  mockMayAct = true;
  mockForeground.stopped = 0;
});
afterEach(() => {
  qc.clear();
  jest.useRealTimers();
});

describe('useOpmlImport', () => {
  it('refuses a file over 1 MiB here, before any upload', async () => {
    const { result } = await mount();
    await act(async () => result.current.start(file(OPML_MAX_BYTES + 1)));
    expect(result.current.problem).toBe('tooLarge');
    expect(result.current.fileName).toBe('subs.opml');
    expect(result.current.state).toBeNull();
    expect(mockClient.importOpml).not.toHaveBeenCalled();
  });

  it('uploads the bytes to the library, and a list with nothing left over is done', async () => {
    mockClient.importOpml.mockResolvedValue(answer([row(0, 'followed'), row(1, 'queued')]));
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    const { result } = await mount();
    const picked = file();
    await act(async () => result.current.start(picked));
    expect(mockClient.importOpml).toHaveBeenCalledWith(7, picked.body, expect.any(AbortSignal));
    expect(result.current.state?.status).toEqual({ kind: 'done' });
    expect(result.current.state?.rows).toHaveLength(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.podcastShows('c1', 7) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.myPodcasts('c1') });
  });

  it('reads the follow requests again for rows already queued elsewhere', async () => {
    mockClient.importOpml.mockResolvedValue(answer([row(0, 'already_queued')]));
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    const { result } = await mount();
    await act(async () => result.current.start(file()));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.myPodcasts('c1') });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: qk.podcastShows('c1', 7) });
  });

  it('reads the follow requests through the shared cache entry between waves', async () => {
    mockClient.importOpml
      .mockResolvedValueOnce(answer([row(0, 'queued'), row(1, 'limited')]))
      .mockResolvedValueOnce(answer([row(1, 'queued')]));
    const { result } = await mount();
    await act(async () => result.current.start(file()));
    expect(mockClient.myPodcasts).toHaveBeenCalledTimes(1);
    expect(qc.getQueryData(qk.myPodcasts('c1'))).toEqual({ shows: [], requests: [] });
    expect(result.current.state?.status.kind).toBe('waitingTime');
    await act(async () => jest.advanceTimersByTime(WAVE_SPACING_MS));
    expect(mockClient.importOpml).toHaveBeenCalledTimes(2);
    expect(result.current.state?.status).toEqual({ kind: 'done' });
  });

  it('holds its timers in the background and looks again on return', async () => {
    mockClient.importOpml
      .mockResolvedValueOnce(answer([row(0, 'limited'), row(1, 'queued')]))
      .mockResolvedValueOnce(answer([row(0, 'queued')]));
    const { result } = await mount();
    await act(async () => result.current.start(file()));
    await act(async () => mockForeground.leave!());
    await act(async () => jest.advanceTimersByTime(WAVE_SPACING_MS * 4));
    expect(mockClient.importOpml).toHaveBeenCalledTimes(1);
    await act(async () => mockForeground.fn!());
    expect(mockClient.importOpml).toHaveBeenCalledTimes(2);
  });

  it('stops before an upload once someone else is listening', async () => {
    mockMayAct = false;
    const { result } = await mount();
    await act(async () => result.current.start(file()));
    expect(result.current.state?.status).toEqual({ kind: 'stopped', why: 'cantAct' });
    expect(mockClient.importOpml).not.toHaveBeenCalled();
  });

  it('sends nothing more once the page goes', async () => {
    mockClient.importOpml.mockResolvedValue(answer([row(0, 'limited'), row(1, 'queued')]));
    const { result, unmount } = await mount();
    await act(async () => result.current.start(file()));
    await unmount();
    expect(mockForeground.stopped).toBe(1);
    await act(async () => jest.advanceTimersByTime(WAVE_SPACING_MS * 4));
    expect(mockClient.importOpml).toHaveBeenCalledTimes(1);
  });

  it('a file that could not be read says so and drops the import', async () => {
    const { result } = await mount();
    await act(async () => result.current.unreadable());
    expect(result.current.problem).toBe('unreadable');
    expect(result.current.state).toBeNull();
  });

  describe("a row's own Try again (BRIDGE-01)", () => {
    const OPML = `<?xml version="1.0"?>
<opml version="2.0"><head><title>Subs</title></head><body>
  <outline text="One" type="rss" xmlUrl="https://example.com/one.xml"/>
  <outline text="Two" type="rss" xmlUrl="https://other.example/two.xml"/>
</body></opml>`;
    const listFile = () => {
      const body = new TextEncoder().encode(OPML);
      return { name: 'subs.opml', size: body.length, body };
    };
    const failed = (i: number, feed: string): OpmlImportRow => ({
      ...row(i, 'error'),
      feed,
      request_id: 90 + i,
      error: { code: 'recently_failed', message: 'x' },
    });

    async function started(rows: OpmlImportRow[]) {
      mockClient.importOpml.mockResolvedValue(answer(rows));
      const hook = await mount();
      await act(async () => hook.result.current.start(listFile()));
      // The capability read and the list's text.
      await act(async () => jest.advanceTimersByTimeAsync(0));
      return hook;
    }

    it("follows the row's address from the list, and its answer stands over the wave's", async () => {
      const one = failed(1, 'https://example.com/...');
      const { result } = await started([one, row(2, 'followed')]);
      expect(result.current.canRetryRow(one)).toBe(true);
      expect(result.current.canRetryRow(row(2, 'followed'))).toBe(false);
      mockClient.followPodcastByUrl.mockResolvedValue({
        state: 'subscribing',
        request: { id: 55, state: 'queued', library_id: 7 },
      });
      await act(async () => result.current.retryRow(one));
      await act(async () => jest.advanceTimersByTimeAsync(0));
      expect(mockClient.followPodcastByUrl).toHaveBeenCalledWith(7, 'https://example.com/one.xml', {
        private: undefined,
      });
      expect(result.current.retries[1]).toEqual({
        kind: 'answered',
        row: { ...one, status: 'queued', request_id: 55, error: null },
      });
    });

    it("offers none when the list's address there is not the row's feed", async () => {
      // The server's label names another host than the list holds at that place.
      const two = failed(2, 'https://example.com/...');
      const { result } = await started([two]);
      expect(result.current.canRetryRow(two)).toBe(false);
      await act(async () => result.current.retryRow(two));
      expect(mockClient.followPodcastByUrl).not.toHaveBeenCalled();
    });

    it('sends one follow for two quick taps, and drops an answer that lands on a new list', async () => {
      const one = failed(1, 'https://example.com/...');
      const { result } = await started([one]);
      let answerFollow: (v: unknown) => void = () => {};
      mockClient.followPodcastByUrl.mockImplementation(
        () => new Promise((resolve) => (answerFollow = resolve)),
      );
      await act(async () => {
        result.current.retryRow(one);
        result.current.retryRow(one);
      });
      await act(async () => jest.advanceTimersByTimeAsync(0));
      expect(mockClient.followPodcastByUrl).toHaveBeenCalledTimes(1);
      // Another list is picked while the follow is on its way: its row 1 is not that feed.
      mockClient.importOpml.mockResolvedValue(answer([row(1, 'followed')]));
      await act(async () => result.current.start(listFile()));
      await act(async () => {
        answerFollow({ state: 'subscribing', request: { id: 55, state: 'queued', library_id: 7 } });
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(result.current.retries).toEqual({});
    });

    it('says why a follow by address was refused, and the row stays as it was', async () => {
      const one = failed(1, 'https://example.com/...');
      const { result } = await started([one]);
      const { ApiError } = jest.requireActual('@/api/client');
      mockClient.followPodcastByUrl.mockRejectedValue(new ApiError(500, 'x'));
      await act(async () => result.current.retryRow(one));
      await act(async () => jest.advanceTimersByTimeAsync(0));
      expect(mockToast).toHaveBeenCalledTimes(1);
      expect(result.current.retries[1]).toBeUndefined();
    });
  });
});
