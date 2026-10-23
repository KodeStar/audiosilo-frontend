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
};
jest.mock('@/api/provider', () => ({ useOptionalApi: () => mockClient }));
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
});
