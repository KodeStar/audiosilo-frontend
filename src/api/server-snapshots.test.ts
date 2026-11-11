import AsyncStorage from '@react-native-async-storage/async-storage';
import type { QueryClient } from '@tanstack/react-query';

import type { ServerInfo } from '@/api/types';

// One real query cache (what the screens read), with the app's default 5 min gcTime so
// the "kept for the session" rule is observable.
jest.mock('@/api/provider', () => {
  const { QueryClient: QC } = jest.requireActual('@tanstack/react-query');
  return { queryClient: new QC({ defaultOptions: { queries: { retry: false } } }) };
});
// The session: two signed-in connections, and the removal listeners the modules register
// (kept on the mock: the factory runs before this file's own constants exist).
jest.mock('@/stores/session', () => {
  const { create } = jest.requireActual('zustand');
  const removed: ((id: string) => void)[] = [];
  return {
    useSession: create(() => ({ status: 'ready', connections: [{ id: 'c1' }, { id: 'c2' }] })),
    onConnectionRemoved: (cb: (id: string) => void) => {
      removed.push(cb);
      return () => undefined;
    },
    removed,
  };
});

/* eslint-disable import/first */
import { cachedCapability, qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { OFFLINE_SERVERS_KEY } from '@/lib/storage-keys';

import {
  forgetServerSnapshot,
  keepServerAnswer,
  readServerSnapshots,
  resetServerSnapshotsForTests,
  restoreServerSnapshots,
  saveServerSnapshot,
  seedServerSnapshot,
  watchServerAnswers,
} from './server-snapshots';
/* eslint-enable import/first */

const qc = queryClient as QueryClient;

function server(caps: Record<string, boolean>): ServerInfo {
  return {
    name: 'S',
    server_id: 'srv',
    version: '1',
    api: '1',
    capabilities: caps as never,
    auth: { methods: [] },
  };
}

/** Every write queued so far has landed (a no-op change runs after them). */
const written = () => forgetServerSnapshot('nobody');
/** A `/server` answer arriving from a request, as a screen's query gets it. */
const answer = (cid: string, info: ServerInfo) =>
  qc.fetchQuery({ queryKey: qk.server(cid), queryFn: async () => info, staleTime: 0 });

beforeEach(async () => {
  await written();
  await AsyncStorage.clear();
  qc.clear();
  resetServerSnapshotsForTests();
});

describe('seeding a kept /server answer', () => {
  it('fills a cache that has no answer, dated when it was read and kept for the session', () => {
    seedServerSnapshot('c1', { info: server({ metadata: true }), savedAt: 7 });
    expect(cachedCapability('c1', 'metadata')).toBe(true);
    const query = qc.getQueryCache().find({ queryKey: qk.server('c1'), exact: true });
    // Stale at once, so the first observer still asks the server.
    expect(query?.state.dataUpdatedAt).toBe(7);
    expect(query?.gcTime).toBe(Infinity);
  });

  it("never replaces an answer read later (the server's own this launch)", () => {
    qc.setQueryData(qk.server('c2'), server({ metadata: false }), { updatedAt: 50 });
    seedServerSnapshot('c2', { info: server({ metadata: true }), savedAt: 10 });
    expect(cachedCapability('c2', 'metadata')).toBe(false);
  });

  it("replaces an older copy (the web startup cache's, from an earlier visit)", () => {
    qc.setQueryData(qk.server('c2'), server({ metadata: false }), { updatedAt: 5 });
    seedServerSnapshot('c2', { info: server({ metadata: true }), savedAt: 10 });
    expect(cachedCapability('c2', 'metadata')).toBe(true);
  });
});

describe('the kept document', () => {
  it('holds one answer per connection, newer answers only', async () => {
    const snap = (savedAt: number) => ({ info: server({ metadata: savedAt > 1 }), savedAt });
    await saveServerSnapshot('c1', snap(2));
    await saveServerSnapshot('c1', snap(1)); // older: kept as it was
    await saveServerSnapshot('c2', snap(3));
    expect(await readServerSnapshots()).toEqual({ c1: snap(2), c2: snap(3) });
    await forgetServerSnapshot('c2');
    expect(Object.keys(await readServerSnapshots())).toEqual(['c1']);
  });

  it('never loses a write to another one running beside it', async () => {
    const snap = { info: server({ metadata: true }), savedAt: 5 };
    await Promise.all([saveServerSnapshot('c1', snap), saveServerSnapshot('c2', snap)]);
    expect(Object.keys(await readServerSnapshots()).sort()).toEqual(['c1', 'c2']);
  });

  it('is not written again by an answer that says the same', async () => {
    await saveServerSnapshot('c1', { info: server({ queue: true }), savedAt: 5 });
    const set = jest.mocked(AsyncStorage.setItem);
    set.mockClear();
    await saveServerSnapshot('c1', { info: server({ queue: true }), savedAt: 9 });
    expect(set).not.toHaveBeenCalled();
    await saveServerSnapshot('c1', { info: server({ queue: false }), savedAt: 10 });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('is written again once the kept document is gone (a storage reset)', async () => {
    const snap = { info: server({ queue: true }), savedAt: 5 };
    await saveServerSnapshot('c1', snap);
    await AsyncStorage.clear();
    await saveServerSnapshot('c1', snap);
    expect(await readServerSnapshots()).toEqual({ c1: snap });
  });

  it('reads an unreadable document as none, and skips the entries it cannot use', async () => {
    await AsyncStorage.setItem(OFFLINE_SERVERS_KEY, '"nope"');
    expect(await readServerSnapshots()).toEqual({});
    await AsyncStorage.setItem(
      OFFLINE_SERVERS_KEY,
      JSON.stringify({ c1: { info: 'S' }, c2: { info: server({}), savedAt: 1 } }),
    );
    expect(Object.keys(await readServerSnapshots())).toEqual(['c2']);
  });

  it("forgets a removed connection's answer", async () => {
    await saveServerSnapshot('c1', { info: server({}), savedAt: 1 });
    const { removed } = jest.requireMock<{ removed: ((id: string) => void)[] }>('@/stores/session');
    for (const cb of removed) cb('c1');
    await written();
    expect(await readServerSnapshots()).toEqual({});
  });
});

describe('keeping every answer', () => {
  beforeEach(() => watchServerAnswers());

  it("keeps a signed-in connection's /server answer as it arrives", async () => {
    await answer('c1', server({ listening_sync: true }));
    await written();
    const kept = await readServerSnapshots();
    expect(kept.c1.info.capabilities.listening_sync).toBe(true);
    expect(kept.c1.savedAt).toBe(qc.getQueryState(qk.server('c1'))?.dataUpdatedAt);
    // The next answer replaces it.
    await answer('c1', server({ listening_sync: false }));
    await written();
    expect((await readServerSnapshots()).c1.info.capabilities.listening_sync).toBe(false);
  });

  it('a copy put in the cache (a seed, setQueryData) is no answer', async () => {
    seedServerSnapshot('c1', { info: server({ metadata: true }), savedAt: 3 });
    qc.setQueryData(qk.server('c2'), server({ metadata: true }));
    await written();
    expect(await readServerSnapshots()).toEqual({});
  });

  it('keeps nothing for a connection that is not signed in, nor for another query', async () => {
    await answer('stranger', server({ metadata: true }));
    await qc.fetchQuery({ queryKey: qk.libraries('c1'), queryFn: async () => [] });
    await written();
    expect(await readServerSnapshots()).toEqual({});
  });

  it('keeps an answer read outside the cache, and the cache takes it', async () => {
    keepServerAnswer('c1', server({ listening_sync: false }));
    expect(cachedCapability('c1', 'listening_sync')).toBe(false);
    await written();
    expect((await readServerSnapshots()).c1.info.capabilities.listening_sync).toBe(false);
  });

  it('asks the cache again for an answer with no flags at all', async () => {
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    keepServerAnswer('c1', { name: 'S' } as ServerInfo);
    expect(qc.getQueryData(qk.server('c1'))).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.server('c1') });
    await written();
    expect(await readServerSnapshots()).toEqual({});
    invalidate.mockRestore();
  });
});

describe('the launch', () => {
  it("knows every connection's flags with no request, downloads or not", async () => {
    await AsyncStorage.setItem(
      OFFLINE_SERVERS_KEY,
      JSON.stringify({
        c1: { info: server({ listening_sync: false, readalong: true }), savedAt: 1 },
        c2: { info: server({ listening_sync: true }), savedAt: 2 },
      }),
    );
    // Before the seed: unknown.
    expect(cachedCapability('c1', 'listening_sync')).toBeUndefined();
    await restoreServerSnapshots();
    expect(cachedCapability('c1', 'listening_sync')).toBe(false);
    expect(cachedCapability('c1', 'readalong')).toBe(true);
    expect(cachedCapability('c2', 'listening_sync')).toBe(true);
    // A flag the kept answer does not carry reads as off, like any answer's.
    expect(cachedCapability('c2', 'readalong')).toBe(false);
  });

  it('runs once, and an unreadable document seeds nothing', async () => {
    await AsyncStorage.setItem(OFFLINE_SERVERS_KEY, '{bad');
    const first = restoreServerSnapshots();
    expect(restoreServerSnapshots()).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(cachedCapability('c1', 'listening_sync')).toBeUndefined();
  });

  it('follows the answers after it, without rewriting what it just read', async () => {
    const kept = { info: server({ queue: true }), savedAt: 1 };
    await AsyncStorage.setItem(OFFLINE_SERVERS_KEY, JSON.stringify({ c1: kept }));
    await restoreServerSnapshots();
    const set = jest.mocked(AsyncStorage.setItem);
    set.mockClear();
    await answer('c1', server({ queue: true }));
    await written();
    expect(set).not.toHaveBeenCalled();
    await answer('c1', server({ queue: false }));
    await written();
    expect((await readServerSnapshots()).c1.info.capabilities.queue).toBe(false);
  });
});
