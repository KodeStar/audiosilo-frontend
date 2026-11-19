import AsyncStorage from '@react-native-async-storage/async-storage';
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
// One object each: a selector that makes a new one at every call never settles.
const mockNotAsked: Read = {};
const mockUnread: Read = { isPending: true };
// Each read asked: its id (undefined: not asked) and `active`.
const mockAsked: { id: number | undefined; active: boolean; cid?: string }[] = [];
const mockInvalidateLists = jest.fn();
// Each connection's `/server` answer: its `bridge` flag (the Bridge online), and its refetch.
const mockBridge = create<Record<string, boolean>>(() => ({}));
const mockServerRefetch = jest.fn();
jest.mock('@/api/hooks', () => ({
  qk: {
    librivoxWorks: (cid: string) => ['librivoxWork', cid],
    bridgeJob: (cid: string, id: number) => ['bridgeJob', cid, id],
  },
  invalidateLibraryLists: (...a: unknown[]) => mockInvalidateLists(...a),
  useServerInfo: (cid: string) => {
    const bridge = mockBridge((s) => s[cid] ?? true);
    return { data: { capabilities: { bridge } }, refetch: () => mockServerRefetch(cid) };
  },
  useLibrivoxJob: (id: number | undefined, active: boolean, cid?: string) => {
    mockAsked.push({ id, active, cid });
    return mockReads((s) => (id === undefined ? mockNotAsked : (s[id] ?? mockUnread)));
  },
}));

/* eslint-disable import/first */
import { BRIDGE_IDLE_POLL_MS } from '@/lib/bridge-jobs';
import { LIBRIVOX_WATCHES_KEY } from '@/lib/storage-keys';
import { driveAppState } from '@/testing/app-state';

import {
  LibrivoxFetchWatcher,
  resetLibrivoxWatchesForTests,
  restoreLibrivoxWatches,
  useLibrivoxWatches,
  WATCH_TTL_MS,
  watchLibrivoxFetch,
} from './fetch-watcher';
import { DONE_RECHECK_MS } from './librivox-model';
/* eslint-enable import/first */

const app = driveAppState();

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

/** The watches, without when each was first watched. */
const watches = () => useLibrivoxWatches.getState().watches.map(({ cid, id }) => ({ cid, id }));
const answer = (id: number, read: Read) => act(async () => mockReads.setState({ [id]: read }));

beforeEach(async () => {
  // The saved list read once (as the first mount does), then emptied.
  await restoreLibrivoxWatches();
  useLibrivoxWatches.setState({ watches: [] });
  mockBridge.setState({}, true);
  mockServerRefetch.mockReset();
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

  it.each([400, 403])('stops on a refusal (%i), reading nothing again', async (status) => {
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

  it("holds, asking nothing, while the fetch's connection is signed out, then handles its end after the sign-in (fe#299)", async () => {
    signIn('c1', 'c2');
    mockReads.setState({ 41: { data: librivoxJob({ id: 41, state: 'running' }) } });
    const { qc, worksAsks } = await mount();
    await act(async () => {
      watchLibrivoxFetch('c1', 41);
      watchLibrivoxFetch('c2', 41);
    });
    expect(watches()).toHaveLength(2);
    mockAsked.length = 0;
    await act(async () => signIn('c2'));
    expect(watches()).toEqual([
      { cid: 'c1', id: 41 },
      { cid: 'c2', id: 41 },
    ]);
    expect(mockAsked.filter((a) => a.cid === 'c1' && a.id !== undefined)).toEqual([]);
    // It ended while signed out: handled once signed in again.
    mockReads.setState({ 41: { data: librivoxJob({ id: 41, state: 'done', library_id: 3 }) } });
    expect(worksAsks()).toBe(0);
    await act(async () => signIn('c1', 'c2'));
    expect(mockInvalidateLists).toHaveBeenCalledWith(qc, 'c1', 3);
    expect(worksAsks()).toBe(1);
    expect(watches()).toEqual([]);
  });

  it('holds a fetch refused with a 401 until its connection is signed in again (fe#299)', async () => {
    mockReads.setState({ 41: { error: new ApiError(401, 'unauthorized') } });
    await mount();
    await act(async () => {
      // The client flagged the connection as it answered 401.
      useSession.setState({
        connections: [
          { id: 'c1', name: 'c1', serverUrl: 'u', token: 't', needsReconnect: 'auth' } as never,
        ],
      });
      watchLibrivoxFetch('c1', 41);
    });
    expect(watches()).toEqual([{ cid: 'c1', id: 41 }]);
    expect(mockAsked.at(-1)).toEqual({ id: undefined, active: true, cid: 'c1' });
    await act(async () => signIn('c1'));
    expect(mockAsked.at(-1)).toEqual({ id: 41, active: true, cid: 'c1' });
    expect(watches()).toEqual([{ cid: 'c1', id: 41 }]);
  });

  it('lets a signed-out watch go once it is older than any fetch takes', async () => {
    signIn();
    mockReads.setState({ 41: { data: librivoxJob({ id: 41, state: 'running' }) } });
    await mount();
    await act(async () =>
      useLibrivoxWatches.setState({
        watches: [
          { cid: 'c1', id: 41, at: Date.now() - WATCH_TTL_MS },
          { cid: 'c1', id: 42, at: Date.now() },
        ],
      }),
    );
    expect(watches()).toEqual([{ cid: 'c1', id: 42 }]);
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

  describe('the Bridge away (fe#299)', () => {
    it('asks /server again in the foreground until the Bridge is back', async () => {
      mockReads.setState({ 41: { data: librivoxJob({ id: 41, state: 'running' }) } });
      jest.useFakeTimers();
      try {
        await mount();
        await act(async () => watchLibrivoxFetch('c1', 41));
        await act(async () => jest.advanceTimersByTime(BRIDGE_IDLE_POLL_MS));
        // Online: nothing to wait for.
        expect(mockServerRefetch).not.toHaveBeenCalled();
        await act(async () => mockBridge.setState({ c1: false }));
        await act(async () => jest.advanceTimersByTime(BRIDGE_IDLE_POLL_MS));
        expect(mockServerRefetch).toHaveBeenCalledTimes(1);
        expect(mockServerRefetch).toHaveBeenCalledWith('c1');
        app.becomes('background');
        await act(async () => jest.advanceTimersByTime(BRIDGE_IDLE_POLL_MS));
        expect(mockServerRefetch).toHaveBeenCalledTimes(1);
        app.becomes('active');
        await act(async () => mockBridge.setState({ c1: true }));
        await act(async () => jest.advanceTimersByTime(BRIDGE_IDLE_POLL_MS));
        expect(mockServerRefetch).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('asks nothing for a connection that is signed out', async () => {
      signIn();
      mockBridge.setState({ c1: false });
      jest.useFakeTimers();
      try {
        await mount();
        await act(async () => watchLibrivoxFetch('c1', 41));
        await act(async () => jest.advanceTimersByTime(BRIDGE_IDLE_POLL_MS));
        expect(mockServerRefetch).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('across a restart (fe#299)', () => {
    afterEach(() => resetLibrivoxWatchesForTests());

    it('saves the watches, and follows the saved ones again at the next launch', async () => {
      mockReads.setState({ 41: { data: librivoxJob({ id: 41, state: 'running' }) } });
      await mount();
      await act(async () => watchLibrivoxFetch('c1', 41));
      const saved = JSON.parse((await AsyncStorage.getItem(LIBRIVOX_WATCHES_KEY))!);
      expect(saved).toEqual([{ cid: 'c1', id: 41, at: expect.any(Number) }]);

      // The next launch: nothing in memory, the saved list read once by the first mount.
      resetLibrivoxWatchesForTests();
      useLibrivoxWatches.setState({ watches: [] });
      mockAsked.length = 0;
      await mount();
      expect(watches()).toEqual([{ cid: 'c1', id: 41 }]);
      expect(mockAsked).toContainEqual({ id: 41, active: true, cid: 'c1' });
    });

    it('drops saved watches past their time, and anything not a watch', async () => {
      await AsyncStorage.setItem(
        LIBRIVOX_WATCHES_KEY,
        JSON.stringify([
          { cid: 'c1', id: 41, at: Date.now() - WATCH_TTL_MS },
          { cid: 'c1', id: 42, at: Date.now() },
          { cid: 'c1', id: '43' },
          'junk',
        ]),
      );
      resetLibrivoxWatchesForTests();
      await restoreLibrivoxWatches();
      expect(watches()).toEqual([{ cid: 'c1', id: 42 }]);
    });

    it('keeps a fetch watched before the saved list was read', async () => {
      await AsyncStorage.setItem(
        LIBRIVOX_WATCHES_KEY,
        JSON.stringify([{ cid: 'c1', id: 42, at: Date.now() }]),
      );
      resetLibrivoxWatchesForTests();
      watchLibrivoxFetch('c1', 41);
      await restoreLibrivoxWatches();
      expect(watches()).toEqual([
        { cid: 'c1', id: 42 },
        { cid: 'c1', id: 41 },
      ]);
    });
  });
});
