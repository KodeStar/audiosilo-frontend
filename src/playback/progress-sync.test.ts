import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiClient, ApiError } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import * as reachability from '@/api/reachability';
import type { Progress } from '@/api/types';
import { onConnectionRemoved } from '@/stores/session';

import {
  flushConnection,
  flushQueue,
  loadInitialProgress,
  type ProgressSave,
  saveProgress,
} from '@/playback/progress-sync';

// babel-jest hoists jest.mock above the imports, so the module under test sees the
// mock at import time (it gates every save on isReachable(cid) and notes success/failure
// against each save's own connection). isReachable ignores its cid arg here and returns
// the mocked value, so a test toggles reachability for the single connection it exercises.
jest.mock('@/api/reachability', () => ({
  isReachable: jest.fn(() => true),
  noteError: jest.fn(),
  noteSuccess: jest.fn(),
}));

// The connection-clients seam is what makes progress bleed-proof: every queued save
// routes through ITS OWN connection's client. Mock it so a test controls per-cid client
// routing and session readiness directly, without wiring the real session store.
jest.mock('@/api/connection-clients', () => ({
  resolveClient: jest.fn(() => null),
  sessionReady: jest.fn(() => true),
}));

// progress-sync registers an onConnectionRemoved purge at import time.
jest.mock('@/stores/session', () => ({
  onConnectionRemoved: jest.fn(() => () => {}),
}));

const QUEUE_KEY = 'audiosilo.progressQueue';
const MIRROR_KEY = 'audiosilo.progressMirror';

// The purge callback progress-sync registered at import (captured before any
// clearAllMocks wipes the mock's call log).
const removalCleanup = (onConnectionRemoved as jest.Mock).mock.calls[0]?.[0] as (
  id: string,
) => Promise<void>;

const save: ProgressSave = {
  connectionId: 'c1',
  libraryId: 1,
  path: 'A/Book',
  position: 10,
  duration: 100,
  finished: false,
  playback_speed: 1,
  device_id: 'dev',
  updated_at: '2026-01-01T00:00:00Z',
};

function fakeApi(saveImpl: () => Promise<void>): ApiClient {
  return { saveProgress: jest.fn(saveImpl) } as unknown as ApiClient;
}

/** An api whose getProgress resolves to the given value (null = no record) or rejects. */
function fakeGetApi(getImpl: () => Promise<Progress | null>): ApiClient {
  return {
    getProgress: jest.fn(getImpl),
    saveProgress: jest.fn(async () => {}),
  } as unknown as ApiClient;
}

function makeProgress(p: Partial<Progress> = {}): Progress {
  return {
    library_id: 1,
    path: 'A/Book',
    position: 50,
    duration: 100,
    finished: false,
    playback_speed: 1,
    version: 0,
    device_id: 'dev',
    updated_at: '2026-01-01T00:00:00Z',
    ...p,
  };
}

async function readQueue(): Promise<ProgressSave[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  return raw ? (JSON.parse(raw) as ProgressSave[]) : [];
}

async function readMirror(): Promise<Record<string, ProgressSave>> {
  const raw = await AsyncStorage.getItem(MIRROR_KEY);
  return raw ? (JSON.parse(raw) as Record<string, ProgressSave>) : {};
}

const reachable = reachability.isReachable as jest.Mock;
const mockResolveClient = resolveClient as jest.Mock;
const mockSessionReady = sessionReady as jest.Mock;

/** Route resolveClient(cid) to a canned client per connection id (unknown → null). */
function routeClients(map: Record<string, ApiClient | null>) {
  mockResolveClient.mockImplementation((cid: string) => map[cid] ?? null);
}

describe('progress-sync', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    reachable.mockReset().mockReturnValue(true);
    // clearAllMocks wipes call logs but keeps implementations; reset the seam mocks
    // to their defaults so a per-test override can't leak into the next test.
    mockResolveClient.mockReset().mockReturnValue(null);
    mockSessionReady.mockReset().mockReturnValue(true);
  });

  it('saves straight to the server when reachable', async () => {
    const api = fakeApi(() => Promise.resolve());
    await saveProgress(api, save);
    expect(api.saveProgress).toHaveBeenCalledWith(
      1,
      'A/Book',
      expect.objectContaining({ position: 10 }),
    );
    expect(reachability.noteSuccess).toHaveBeenCalled();
  });

  it('queues offline without hitting the network', async () => {
    reachable.mockReturnValue(false);
    const api = fakeApi(() => Promise.resolve());
    await saveProgress(api, save);
    expect(api.saveProgress).not.toHaveBeenCalled();
    expect(await readQueue()).toHaveLength(1);
  });

  it('keeps only the latest pending save per (connection, library, path)', async () => {
    reachable.mockReturnValue(false);
    const api = fakeApi(() => Promise.resolve());
    await saveProgress(api, { ...save, position: 10 });
    await saveProgress(api, { ...save, position: 20 });
    const q = await readQueue();
    expect(q).toHaveLength(1);
    expect(q[0].position).toBe(20);
  });

  it('drops 4xx (unrecoverable) saves without queuing a retry', async () => {
    const api = fakeApi(() => Promise.reject(new ApiError(403, 'forbidden')));
    await saveProgress(api, save);
    expect(await readQueue()).toHaveLength(0);
  });

  it('enqueues on a connection error, then replays it on the next flush', async () => {
    const failing = fakeApi(() => Promise.reject(new Error('network down')));
    await saveProgress(failing, save);
    expect(reachability.noteError).toHaveBeenCalled();
    expect(await readQueue()).toHaveLength(1);

    // flushQueue takes no args now: it resolves each save to its own connection's client.
    const ok = fakeApi(() => Promise.resolve());
    routeClients({ c1: ok });
    await flushQueue();
    expect(ok.saveProgress).toHaveBeenCalledTimes(1);
    expect(await readQueue()).toHaveLength(0);
  });

  // Review finding F4: overlapping flushes must serialize, not clobber the queue.
  it('serializes concurrent flushes without losing queued saves', async () => {
    reachable.mockReturnValue(false);
    const offline = fakeApi(() => Promise.resolve());
    await saveProgress(offline, { ...save, path: 'A/one', position: 1 });
    await saveProgress(offline, { ...save, path: 'A/two', position: 2 });
    expect(await readQueue()).toHaveLength(2);

    reachable.mockReturnValue(true);
    const ok = fakeApi(() => Promise.resolve());
    routeClients({ c1: ok });
    await Promise.all([flushQueue(), flushQueue()]);

    // Each queued save sent exactly once; the queue is drained, nothing lost.
    expect(ok.saveProgress).toHaveBeenCalledTimes(2);
    expect(await readQueue()).toHaveLength(0);
  });

  // --- per-connection routing (the anti-bleed guarantee) ---------------------

  it('routes each queued save to its OWN connection client (no cross-server bleed)', async () => {
    reachable.mockReturnValue(false);
    const offline = fakeApi(() => Promise.resolve());
    await saveProgress(offline, { ...save, connectionId: 'c1', position: 11 });
    await saveProgress(offline, { ...save, connectionId: 'c2', position: 22 });
    // Same (library, path) under two connections coexist (dedupe is per-cid).
    expect(await readQueue()).toHaveLength(2);

    reachable.mockReturnValue(true);
    const c1 = fakeApi(() => Promise.resolve());
    const c2 = fakeApi(() => Promise.resolve());
    routeClients({ c1, c2 });
    await flushQueue();

    expect(c1.saveProgress).toHaveBeenCalledTimes(1);
    expect(c1.saveProgress).toHaveBeenCalledWith(
      1,
      'A/Book',
      expect.objectContaining({ position: 11 }),
    );
    expect(c2.saveProgress).toHaveBeenCalledTimes(1);
    expect(c2.saveProgress).toHaveBeenCalledWith(
      1,
      'A/Book',
      expect.objectContaining({ position: 22 }),
    );
    expect(await readQueue()).toHaveLength(0);
  });

  it('drops a queued save whose connection no longer exists, still flushing the rest', async () => {
    reachable.mockReturnValue(false);
    const offline = fakeApi(() => Promise.resolve());
    await saveProgress(offline, { ...save, connectionId: 'c1', position: 11 });
    await saveProgress(offline, { ...save, connectionId: 'gone', position: 99 });
    expect(await readQueue()).toHaveLength(2);

    reachable.mockReturnValue(true);
    const c1 = fakeApi(() => Promise.resolve());
    routeClients({ c1 }); // 'gone' resolves to null → unroutable group dropped
    await flushQueue();

    expect(c1.saveProgress).toHaveBeenCalledTimes(1);
    // The routable group flushed; the orphaned group was dropped → queue empty.
    expect(await readQueue()).toHaveLength(0);
  });

  it('is a no-op while the session is not ready (queue left intact)', async () => {
    reachable.mockReturnValue(false);
    const offline = fakeApi(() => Promise.resolve());
    await saveProgress(offline, { ...save, position: 11 });
    expect(await readQueue()).toHaveLength(1);

    reachable.mockReturnValue(true);
    mockSessionReady.mockReturnValue(false);
    const c1 = fakeApi(() => Promise.resolve());
    routeClients({ c1 });
    await flushQueue();

    expect(c1.saveProgress).not.toHaveBeenCalled();
    expect(await readQueue()).toHaveLength(1); // nothing routed while unready
  });

  it("one connection's failure does not block another connection's group", async () => {
    reachable.mockReturnValue(false);
    const offline = fakeApi(() => Promise.resolve());
    // Enqueue the failing connection FIRST so it's processed before the healthy one.
    await saveProgress(offline, { ...save, connectionId: 'c2', position: 22 });
    await saveProgress(offline, { ...save, connectionId: 'c1', position: 11 });
    expect(await readQueue()).toHaveLength(2);

    reachable.mockReturnValue(true);
    const c1 = fakeApi(() => Promise.resolve());
    const c2 = fakeApi(() => Promise.reject(new Error('c2 down'))); // non-4xx: keep it
    routeClients({ c1, c2 });
    await flushQueue();

    // c2 failed and stays queued; c1 still flushed despite c2's failure.
    expect(c1.saveProgress).toHaveBeenCalledTimes(1);
    expect(c2.saveProgress).toHaveBeenCalledTimes(1);
    const q = await readQueue();
    expect(q.map((s) => s.connectionId)).toEqual(['c2']);
  });

  it('a per-save server error (5xx) does not block the rest of its connection group', async () => {
    reachable.mockReturnValue(false);
    const offline = fakeApi(() => Promise.resolve());
    await saveProgress(offline, { ...save, path: 'A/poison', position: 1 });
    await saveProgress(offline, { ...save, path: 'A/good', position: 2 });
    expect(await readQueue()).toHaveLength(2);

    reachable.mockReturnValue(true);
    let n = 0;
    // Head save 500s (the server ANSWERED), the next succeeds - the server is reachable,
    // so the poison entry must not block the healthy one behind it.
    const c1 = fakeApi(() => {
      n += 1;
      return n === 1 ? Promise.reject(new ApiError(500, 'boom')) : Promise.resolve();
    });
    routeClients({ c1 });
    await flushQueue();

    expect(c1.saveProgress).toHaveBeenCalledTimes(2); // both attempted
    expect((await readQueue()).map((s) => s.path)).toEqual(['A/poison']); // only the 5xx stays
  });

  it('a connection error stops the rest of its group (server unreachable)', async () => {
    reachable.mockReturnValue(false);
    const offline = fakeApi(() => Promise.resolve());
    await saveProgress(offline, { ...save, path: 'A/first', position: 1 });
    await saveProgress(offline, { ...save, path: 'A/second', position: 2 });

    reachable.mockReturnValue(true);
    // A network error (non-ApiError) means the server is down - don't hammer the rest.
    const c1 = fakeApi(() => Promise.reject(new Error('network down')));
    routeClients({ c1 });
    await flushQueue();

    expect(c1.saveProgress).toHaveBeenCalledTimes(1); // stopped after the first failure
    expect((await readQueue()).map((s) => s.path)).toEqual(['A/first', 'A/second']); // both kept
  });

  it('onConnectionRemoved purges only the removed connection’s mirror + queue entries', async () => {
    reachable.mockReturnValue(false);
    const offline = fakeApi(() => Promise.resolve());
    await saveProgress(offline, { ...save, connectionId: 'c1', path: 'X', position: 1 });
    await saveProgress(offline, { ...save, connectionId: 'c2', path: 'X', position: 2 });

    await removalCleanup('c1');

    const mirror = await readMirror();
    expect(mirror['c1:1:X']).toBeUndefined();
    expect(mirror['c2:1:X']).toBeDefined();
    const q = await readQueue();
    expect(q.map((s) => s.connectionId)).toEqual(['c2']);
  });

  // --- flushConnection: last-chance drain of one connection before it's purged --------

  it('flushConnection drains one connection even while it is marked offline', async () => {
    // Two connections queued saves while offline.
    reachable.mockReturnValue(false);
    const offline = fakeApi(() => Promise.resolve());
    await saveProgress(offline, { ...save, connectionId: 'c1', position: 11 });
    await saveProgress(offline, { ...save, connectionId: 'c2', position: 22 });
    expect(await readQueue()).toHaveLength(2);

    // Every connection still marked offline so flushQueue() would skip them all, but
    // flushConnection does NOT gate on isReachable - it drains ONLY c2 (the connection
    // being torn down / just reconnected), leaving c1's queued save intact.
    reachable.mockReturnValue(false);
    const c2 = fakeApi(() => Promise.resolve());
    routeClients({ c2 });
    await flushConnection('c2');

    expect(c2.saveProgress).toHaveBeenCalledTimes(1);
    expect(await readQueue()).toEqual([expect.objectContaining({ connectionId: 'c1' })]);
  });

  it('flushConnection keeps the queue intact when the connection is already gone', async () => {
    reachable.mockReturnValue(false);
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      { ...save, connectionId: 'c2' },
    );
    mockResolveClient.mockReturnValue(null); // connection removed → unroutable
    await flushConnection('c2');
    expect(await readQueue()).toHaveLength(1); // not dropped - can't sync, keep it
  });

  // --- reachability is per-connection (each save notes only its OWN server) -----------
  // A book keeps playing on a connection the user navigated away from; its 15s save loop
  // hits saveProgress. Each save notes success/failure against ITS OWN connection, so one
  // server's outage never flips another's banner.

  it('a failed save notes the error against its own connection', async () => {
    reachable.mockReturnValue(true);
    const failing = fakeApi(() => Promise.reject(new Error('server B down')));
    await saveProgress(failing, { ...save, connectionId: 'c2' });
    expect(reachability.noteError).toHaveBeenCalledWith('c2', expect.any(Error));
  });

  it('a successful save notes success against its own connection', async () => {
    reachable.mockReturnValue(true);
    const ok = fakeApi(() => Promise.resolve());
    await saveProgress(ok, { ...save, connectionId: 'c2' });
    expect(reachability.noteSuccess).toHaveBeenCalledWith('c2');
  });

  it("loadInitialProgress notes a fetch failure against the book's own connection", async () => {
    reachable.mockReturnValue(true);
    const down = fakeGetApi(() => Promise.reject(new Error('server B down')));
    await loadInitialProgress(down, 'c2', 1, 'A/Book');
    expect(reachability.noteError).toHaveBeenCalledWith('c2', expect.any(Error));
  });

  // --- durable mirror + resume lookup (never restart an in-progress book from 0) ---

  it('writes the durable mirror on a successful (online) save', async () => {
    const api = fakeApi(() => Promise.resolve());
    await saveProgress(api, { ...save, position: 42 });
    const mirror = await readMirror();
    expect(mirror['c1:1:A/Book']).toMatchObject({ position: 42 });
  });

  it('writes the durable mirror even when offline', async () => {
    reachable.mockReturnValue(false);
    const api = fakeApi(() => Promise.resolve());
    await saveProgress(api, { ...save, position: 17 });
    expect((await readMirror())['c1:1:A/Book']).toMatchObject({ position: 17 });
  });

  it('keeps the mirror after the offline queue is flushed (never pruned on sync)', async () => {
    reachable.mockReturnValue(false);
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      { ...save, position: 80 },
    );
    expect(await readQueue()).toHaveLength(1);

    reachable.mockReturnValue(true);
    routeClients({ c1: fakeApi(() => Promise.resolve()) });
    await flushQueue();
    expect(await readQueue()).toHaveLength(0); // queue drained...
    expect((await readMirror())['c1:1:A/Book']).toMatchObject({ position: 80 }); // ...mirror remains
  });

  it('loadInitialProgress: returns server progress when reachable', async () => {
    const api = fakeGetApi(() => Promise.resolve(makeProgress({ position: 60 })));
    const r = await loadInitialProgress(api, 'c1', 1, 'A/Book');
    expect(r).toEqual({ kind: 'progress', progress: expect.objectContaining({ position: 60 }) });
  });

  it('loadInitialProgress: returns empty when the server has no record (HTTP 200, null)', async () => {
    const api = fakeGetApi(() => Promise.resolve(null));
    const r = await loadInitialProgress(api, 'c1', 1, 'A/Book');
    expect(r).toEqual({ kind: 'empty' });
  });

  it('loadInitialProgress: falls back to the mirror when the server is unreachable', async () => {
    // Seed the mirror via a save, then make the fetch throw (offline/5xx).
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      { ...save, position: 75 },
    );
    const api = fakeGetApi(() => Promise.reject(new Error('network down')));
    const r = await loadInitialProgress(api, 'c1', 1, 'A/Book');
    expect(r).toEqual({ kind: 'progress', progress: expect.objectContaining({ position: 75 }) });
  });

  it('loadInitialProgress: returns failed only when unreachable AND no local record', async () => {
    const api = fakeGetApi(() => Promise.reject(new Error('network down')));
    const r = await loadInitialProgress(api, 'c1', 1, 'A/Book');
    expect(r).toEqual({ kind: 'failed' });
  });

  it('loadInitialProgress: a mirror for one connection does not surface for another', async () => {
    // Seed c1's mirror; a lookup on c2 (same library/path) must not see it.
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      { ...save, connectionId: 'c1', position: 75 },
    );
    // c2: server reachable + returns nothing → empty (c1's mirror must not leak in).
    const c2 = await loadInitialProgress(
      fakeGetApi(() => Promise.resolve(null)),
      'c2',
      1,
      'A/Book',
    );
    expect(c2).toEqual({ kind: 'empty' });
    // Sanity: c1 still resolves to its own mirror.
    const c1 = await loadInitialProgress(
      fakeGetApi(() => Promise.resolve(null)),
      'c1',
      1,
      'A/Book',
    );
    expect(c1).toMatchObject({ kind: 'progress', progress: { position: 75 } });
  });

  it('loadInitialProgress: reconciles by updated_at - newer mirror wins over older server', async () => {
    // Mirror is newer than what the server returns.
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      {
        ...save,
        position: 90,
        updated_at: '2026-02-01T00:00:00Z',
      },
    );
    const api = fakeGetApi(() =>
      Promise.resolve(makeProgress({ position: 10, updated_at: '2026-01-01T00:00:00Z' })),
    );
    const r = await loadInitialProgress(api, 'c1', 1, 'A/Book');
    expect(r).toMatchObject({ kind: 'progress', progress: { position: 90 } });
  });

  it('loadInitialProgress: a newer server value wins over an older mirror', async () => {
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      {
        ...save,
        position: 5,
        updated_at: '2026-01-01T00:00:00Z',
      },
    );
    const api = fakeGetApi(() =>
      Promise.resolve(makeProgress({ position: 95, updated_at: '2026-03-01T00:00:00Z' })),
    );
    const r = await loadInitialProgress(api, 'c1', 1, 'A/Book');
    expect(r).toMatchObject({ kind: 'progress', progress: { position: 95 } });
  });
});
