import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react-native';
import { create } from 'zustand';

import { ApiError } from '@/api/client';
import type { BridgeJob } from '@/api/types';
import { useSession } from '@/stores/session';
import { librivoxJob } from '@/testing/librivox-fixtures';

type Read = { data?: BridgeJob; error?: unknown; isPending?: boolean };
// The job reads, as a store so a test can move a job on (a poll's answer) after mounting.
const mockReads = create<Record<number, Read>>(() => ({}));
// Each read asked: its id (undefined: not asked) and `active`.
const mockAsked: { id: number | undefined; active: boolean; cid?: string }[] = [];
const mockInvalidateLists = jest.fn();
jest.mock('@/api/hooks', () => ({
  qk: { librivoxWorks: (cid: string) => ['librivoxWork', cid] },
  invalidateLibraryLists: (...a: unknown[]) => mockInvalidateLists(...a),
  useLibrivoxJob: (id: number | undefined, active: boolean, cid?: string) => {
    mockAsked.push({ id, active, cid });
    return mockReads((s) => (id === undefined ? {} : (s[id] ?? { isPending: true })));
  },
}));

/* eslint-disable import/first */
import {
  LibrivoxFetchWatcher,
  resetLibrivoxWatches,
  useLibrivoxWatches,
  watchLibrivoxFetch,
} from './fetch-watcher';
import { DONE_RECHECK_MS } from './librivox-model';
/* eslint-enable import/first */

const signIn = (...ids: string[]) =>
  useSession.setState({
    connections: ids.map((id) => ({ id, name: id, serverUrl: 'u', token: 't' }) as never),
  });

async function mount() {
  const qc = new QueryClient();
  const invalidate = jest.spyOn(qc, 'invalidateQueries').mockResolvedValue();
  await render(
    <QueryClientProvider client={qc}>
      <LibrivoxFetchWatcher />
    </QueryClientProvider>,
  );
  const worksAsks = () =>
    invalidate.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === '["librivoxWork","c1"]')
      .length;
  return { qc, worksAsks };
}

const watches = () => useLibrivoxWatches.getState().watches;
const answer = (id: number, read: Read) => act(async () => mockReads.setState({ [id]: read }));

beforeEach(() => {
  resetLibrivoxWatches();
  mockReads.setState({}, true);
  mockAsked.length = 0;
  mockInvalidateLists.mockReset();
  signIn('c1');
});

describe('LibrivoxFetchWatcher', () => {
  it('reads the Library again when a fetch ends after the page has gone', async () => {
    jest.useFakeTimers();
    try {
      mockReads.setState({ 41: { data: librivoxJob({ id: 41, state: 'running' }) } });
      const { qc, worksAsks } = await mount();
      // Added on the page, which then closed: only the watcher follows it now.
      await act(async () => watchLibrivoxFetch('c1', 41));
      expect(mockAsked).toContainEqual({ id: 41, active: true, cid: 'c1' });
      expect(worksAsks()).toBe(0);
      await answer(41, { data: librivoxJob({ id: 41, state: 'done', library_id: 3 }) });
      expect(mockInvalidateLists).toHaveBeenCalledWith(qc, 'c1', 3);
      expect(worksAsks()).toBe(1);
      expect(watches()).toEqual([]);
      // The recheck is the module's: it fires with the watch (and its component) gone.
      await act(async () => {
        jest.advanceTimersByTime(DONE_RECHECK_MS);
      });
      expect(worksAsks()).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps watching an open fetch, and reads nothing else', async () => {
    mockReads.setState({ 41: { data: librivoxJob({ id: 41, state: 'needs_attention' }) } });
    const { worksAsks } = await mount();
    await act(async () => watchLibrivoxFetch('c1', 41));
    expect(watches()).toEqual([{ cid: 'c1', id: 41 }]);
    expect(worksAsks()).toBe(0);
    expect(mockInvalidateLists).not.toHaveBeenCalled();
  });

  it('asks the works again, but not the lists, for a fetch that failed or was cancelled', async () => {
    mockReads.setState({
      41: { data: librivoxJob({ id: 41, state: 'failed', error: 'exists' }) },
      42: { data: librivoxJob({ id: 42, state: 'cancelled' }) },
    });
    const { worksAsks } = await mount();
    await act(async () => {
      watchLibrivoxFetch('c1', 41);
      watchLibrivoxFetch('c1', 42);
    });
    expect(worksAsks()).toBe(2);
    expect(mockInvalidateLists).not.toHaveBeenCalled();
    expect(watches()).toEqual([]);
  });

  it('asks the works again for a fetch that is gone (a 404), then stops', async () => {
    mockReads.setState({ 41: { error: new ApiError(404, 'gone') } });
    const { worksAsks } = await mount();
    await act(async () => watchLibrivoxFetch('c1', 41));
    expect(worksAsks()).toBe(1);
    expect(mockInvalidateLists).not.toHaveBeenCalled();
    expect(watches()).toEqual([]);
  });

  it.each([400, 401, 403])('stops on a refusal (%i), reading nothing again', async (status) => {
    mockReads.setState({ 41: { error: new ApiError(status, 'no') } });
    const { worksAsks } = await mount();
    await act(async () => watchLibrivoxFetch('c1', 41));
    expect(watches()).toEqual([]);
    expect(worksAsks()).toBe(0);
    expect(mockInvalidateLists).not.toHaveBeenCalled();
  });

  it('keeps watching through a failed read (no answer, a 5xx): the poll asks again', async () => {
    mockReads.setState({ 41: { error: new ApiError(502, 'bad gateway') } });
    const { worksAsks } = await mount();
    await act(async () => watchLibrivoxFetch('c1', 41));
    expect(watches()).toEqual([{ cid: 'c1', id: 41 }]);
    expect(worksAsks()).toBe(0);
  });

  it("stops, asking nothing, once the fetch's connection is signed out", async () => {
    signIn('c1', 'c2');
    mockReads.setState({ 41: { data: librivoxJob({ id: 41, state: 'running' }) } });
    const { worksAsks } = await mount();
    await act(async () => {
      watchLibrivoxFetch('c1', 41);
      watchLibrivoxFetch('c2', 41);
    });
    expect(watches()).toHaveLength(2);
    mockAsked.length = 0;
    await act(async () => signIn('c2'));
    expect(watches()).toEqual([{ cid: 'c2', id: 41 }]);
    expect(mockAsked.filter((a) => a.cid === 'c1' && a.id !== undefined)).toEqual([]);
    expect(worksAsks()).toBe(0);
  });

  it('watches a fetch once, however often it is handed over', async () => {
    mockReads.setState({ 41: { data: librivoxJob({ id: 41, state: 'running' }) } });
    await mount();
    await act(async () => {
      watchLibrivoxFetch('c1', 41);
      watchLibrivoxFetch('c1', 41);
    });
    expect(watches()).toEqual([{ cid: 'c1', id: 41 }]);
  });
});
