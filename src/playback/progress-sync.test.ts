import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { ApiClient, ApiError, TimeoutError } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import { onProxyRefusalsOver } from '@/api/proxy-refusal';
import { forgetRateLimit, RATE_LIMIT_HOLD_S } from '@/api/rate-limit';
import * as reachability from '@/api/reachability';
import type { Progress } from '@/api/types';
import { setConnectionAliases } from '@/lib/connection-id';
import { CONNECTIONS_KEY } from '@/lib/storage-keys';
import { onConnectionRemoved } from '@/stores/session';

import {
  ackVersion,
  flushConnection,
  guardHolds,
  guardSettled,
  onHeldSave,
  onQueueChange,
  flushQueue,
  loadInitialProgress,
  mirrorIsNewest,
  answerOffer,
  ignoreOffer,
  bookPlace,
  positionOn,
  withLocalPlaces,
  noteClockSkew,
  knownSkew,
  noteUndoneFinish,
  onFinishUndoneElsewhere,
  pendingSaveCount,
  pendingSaves,
  routeOnly,
  type LocalPlaces,
  type PlacedProgress,
  progressToSave,
  type ProgressSave,
  readLocalPlaces,
  placeSavedAt,
  readMirror as readMirrorOf,
  resumeLookupOf,
  saveProgress,
  serverRowOf,
  setUndoneChannelForTests,
  tellUndoneElsewhere,
  updateMirror,
  writeFinishedMirror,
  writeMirror,
  readPlaceEarly,
  EARLY_READ_MS,
} from '@/playback/progress-sync';
import { provideStoredSkews } from '@/playback/stored-skews';

// babel-jest hoists jest.mock above the imports, so the module under test sees the
// mock at import time (it gates every save on isReachable(cid) and notes success/failure
// against each save's own connection). isReachable ignores its cid arg here and returns
// the mocked value, so a test toggles reachability for the single connection it exercises.
jest.mock('@/api/reachability', () => ({
  isReachable: jest.fn(() => true),
  noteFailure: jest.fn(),
  noteSuccess: jest.fn(),
}));

// The connection-clients seam is what makes progress bleed-proof: every queued save
// routes through ITS OWN connection's client. Mock it so a test controls per-cid client
// routing and session readiness directly, without wiring the real session store.
jest.mock('@/api/connection-clients', () => ({
  resolveClient: jest.fn(() => null),
  sessionReady: jest.fn(() => true),
}));

// The queues each register a replay for a proxy's refusals ending (captured below).
jest.mock('@/api/proxy-refusal', () => ({ onProxyRefusalsOver: jest.fn(() => () => {}) }));

// progress-sync registers an onConnectionRemoved purge at import time.
jest.mock('@/stores/session', () => ({
  onConnectionRemoved: jest.fn(() => () => {}),
}));

const QUEUE_KEY = 'audiosilo.progressQueue';
const MIRROR_KEY = 'audiosilo.progressMirror';

// A proxy's refusals of a connection ended: the listeners registered at import (captured
// before any clearAllMocks wipes the mock's call log).
const proxyOverListeners = (onProxyRefusalsOver as jest.Mock).mock.calls.map(
  ([fn]) => fn as (cid: string) => void,
);
const proxyRefusalsOver = (cid: string) => proxyOverListeners.forEach((fn) => fn(cid));

// Run the removal callbacks registered at import as the session does, before a new sign-in.
const purges = (onConnectionRemoved as jest.Mock).mock.calls.map(
  ([fn]) => fn as (id: string) => void | Promise<void>,
);
const removalCleanup = (id: string) => Promise.all(purges.map((fn) => fn(id)));

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
function fakeGetApi(
  getImpl: () => Promise<Progress | null>,
  baseUrl = 'http://home.lan:8080',
): ApiClient {
  return {
    baseUrl,
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
    // A 429's wait is the connection's, held in memory: none carried from another test.
    forgetRateLimit('c1');
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

  // An older server's decodeJSON refuses unknown fields (a 400), so a save built from a
  // /me/progress row (which now carries `cover_version`) must PUT only the input's fields.
  it('PUTs only the progress input fields, whatever the save was built from', async () => {
    const api = fakeApi(() => Promise.resolve());
    const fromRow = { ...save, cover_version: 'v7', file: 'A/Book/01.mp3', file_pos: 3 };
    await saveProgress(api, fromRow as typeof save);
    const body = (api.saveProgress as jest.Mock).mock.calls[0][2];
    expect(Object.keys(body).sort()).toEqual([
      'device_id',
      'duration',
      'finished',
      'playback_speed',
      'position',
      'updated_at',
      'version',
    ]);
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

  it('drops a 401 save silently (no throw, no retry loop) - the reconnect flag is raised', async () => {
    // A token revoked mid-listen 401s the 15s save loop. progress-sync must still drop it
    // (no forever-retry). The reconnect banner is NOT raised here: dead-token detection now
    // lives on the ApiClient's onAuthError callback, fired inside a real client's request()
    // before the ApiError reaches this layer. The client the save loop uses is built with
    // that callback (provider.tsx / resolveClient); this layer's job is only to not loop.
    const api = fakeApi(() => Promise.reject(new ApiError(401, 'invalid or expired token')));
    await expect(saveProgress(api, save)).resolves.toBe('dropped');
    expect(await readQueue()).toHaveLength(0);
  });

  // A 408 or a 429 (the server's rate limit) says "not now": the save was dropped, so the
  // place a listener paused at never reached the server.
  it.each([408, 429])(
    'queues a save answered %i, and keeps it through a replay',
    async (status) => {
      const limited = fakeApi(() => Promise.reject(new ApiError(status, 'not now')));
      await expect(saveProgress(limited, save)).resolves.toBe('queued');
      expect(await readQueue()).toHaveLength(1);

      routeClients({ c1: limited });
      await flushQueue();
      expect(await readQueue()).toHaveLength(1);

      // A 429's wait is the connection's, whatever client the next replay is built
      // (`resolveClient` builds one per call): it goes once the wait is over.
      const ok = fakeApi(() => Promise.resolve());
      routeClients({ c1: ok });
      const now = jest.spyOn(Date, 'now');
      try {
        if (status === 429) {
          await flushQueue();
          expect(ok.saveProgress).not.toHaveBeenCalled();
          now.mockReturnValue(Date.now() + RATE_LIMIT_HOLD_S * 1000);
        }
        await flushQueue();
      } finally {
        now.mockRestore();
      }
      expect(ok.saveProgress).toHaveBeenCalledTimes(1);
      expect(await readQueue()).toHaveLength(0);
    },
  );

  it('holds the connection from a live save answered 429: its replay waits too', async () => {
    const limited = fakeApi(() => Promise.reject(new ApiError(429, 'slow down', undefined, 60)));
    await expect(saveProgress(limited, save)).resolves.toBe('queued');
    const ok = fakeApi(() => Promise.resolve());
    routeClients({ c1: ok });
    const now = jest.spyOn(Date, 'now');
    try {
      await flushQueue();
      expect(ok.saveProgress).not.toHaveBeenCalled();
      expect(await readQueue()).toHaveLength(1);
      now.mockReturnValue(Date.now() + 61_000);
      await flushQueue();
    } finally {
      now.mockRestore();
    }
    expect(ok.saveProgress).toHaveBeenCalledTimes(1);
    expect(await readQueue()).toHaveLength(0);
  });

  // A 429 is the connection's, not one save's: the replay stops there and waits out the
  // Retry-After, instead of sending every other queued book into the same limit (fe#173).
  it('stops a replay at a 429 and sends nothing more until its Retry-After is over', async () => {
    reachable.mockReturnValue(false);
    const offline = fakeApi(() => Promise.resolve());
    await saveProgress(offline, { ...save, path: 'A/one' });
    await saveProgress(offline, { ...save, path: 'A/two' });
    reachable.mockReturnValue(true);
    let answer: () => Promise<void> = () =>
      Promise.reject(new ApiError(429, 'slow down', undefined, 60));
    const api = fakeApi(() => answer());
    routeClients({ c1: api });
    const now = jest.spyOn(Date, 'now');
    try {
      await flushQueue();
      expect(api.saveProgress).toHaveBeenCalledTimes(1);
      expect(await readQueue()).toHaveLength(2);
      // Within the wait: nothing is sent.
      answer = () => Promise.resolve();
      await flushQueue();
      expect(api.saveProgress).toHaveBeenCalledTimes(1);
      // The wait is over: both go.
      const later = Date.now() + 61_000;
      now.mockReturnValue(later);
      await flushQueue();
      expect(api.saveProgress).toHaveBeenCalledTimes(3);
      expect(await readQueue()).toHaveLength(0);
    } finally {
      now.mockRestore();
    }
  });

  it('holds a 429 for the connection whatever client a replay is built, but a sign-out tries', async () => {
    reachable.mockReturnValue(false);
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      save,
    );
    reachable.mockReturnValue(true);
    routeClients({
      c1: fakeApi(() => Promise.reject(new ApiError(429, 'slow down', undefined, 60))),
    });
    await flushQueue();
    // `resolveClient` builds a client per call: the next replay's is another one.
    const next = fakeApi(() => Promise.resolve());
    routeClients({ c1: next });
    await flushQueue();
    expect(next.saveProgress).not.toHaveBeenCalled();
    expect(await readQueue()).toHaveLength(1);
    // Signing out (`teardownBeforeTokenRevoke`): the queued saves' last chance.
    await flushConnection('c1');
    expect(next.saveProgress).toHaveBeenCalledTimes(1);
    expect(await readQueue()).toHaveLength(0);
  });

  // A live save sent into a wait the server asked for would only be refused again: it is
  // queued, and the replay at the wait's end sends it.
  it('queues a live save while its connection waits out a 429, and sends it once the wait is over', async () => {
    const limited = fakeApi(() => Promise.reject(new ApiError(429, 'slow down', undefined, 60)));
    await expect(saveProgress(limited, save)).resolves.toBe('queued');
    const ok = fakeApi(() => Promise.resolve());
    routeClients({ c1: ok });
    const now = jest.spyOn(Date, 'now');
    try {
      await expect(saveProgress(ok, { ...save, position: 20 })).resolves.toBe('queued');
      expect(ok.saveProgress).not.toHaveBeenCalled();
      expect(await readQueue()).toEqual([expect.objectContaining({ position: 20 })]);
      now.mockReturnValue(Date.now() + 61_000);
      await expect(saveProgress(ok, { ...save, position: 30 })).resolves.toBe('saved');
    } finally {
      now.mockRestore();
    }
    expect(ok.saveProgress).toHaveBeenCalledWith(
      1,
      'A/Book',
      expect.objectContaining({ position: 30 }),
    );
  });

  // A re-pair while the save waited (the mirror's write, the guard's read): the PUT goes
  // with the token the connection holds then, never the one it held when the save began.
  it("sends a live save through the connection's client at the PUT, not the one it was given", async () => {
    const old = fakeGetApi(async () => {
      routeClients({ c1: fresh });
      return null;
    });
    const fresh = fakeApi(() => Promise.resolve());
    routeClients({ c1: old });
    await expect(saveProgress(old, { ...save, guard: true })).resolves.toBe('saved');
    expect(old.getProgress).toHaveBeenCalledTimes(1);
    expect(old.saveProgress).not.toHaveBeenCalled();
    expect(fresh.saveProgress).toHaveBeenCalledTimes(1);
  });

  it('sends a live save through the client it was given when the connection is not signed in', async () => {
    const api = fakeApi(() => Promise.resolve());
    await expect(saveProgress(api, save)).resolves.toBe('saved');
    expect(api.saveProgress).toHaveBeenCalledTimes(1);
  });

  it('sends each replayed save through the connection as it is then (a re-pair mid-replay)', async () => {
    reachable.mockReturnValue(false);
    const offline = fakeApi(() => Promise.resolve());
    await saveProgress(offline, { ...save, path: 'A/one' });
    await saveProgress(offline, { ...save, path: 'A/two' });
    reachable.mockReturnValue(true);
    const fresh = fakeApi(() => Promise.resolve());
    const old = fakeApi(async () => {
      routeClients({ c1: fresh });
    });
    routeClients({ c1: old });
    await flushQueue();
    expect(old.saveProgress).toHaveBeenCalledTimes(1);
    expect(old.saveProgress).toHaveBeenCalledWith(1, 'A/one', expect.anything());
    expect(fresh.saveProgress).toHaveBeenCalledTimes(1);
    expect(fresh.saveProgress).toHaveBeenCalledWith(1, 'A/two', expect.anything());
    expect(await readQueue()).toHaveLength(0);
  });

  it('enqueues on a connection error, then replays it on the next flush', async () => {
    const failing = fakeApi(() => Promise.reject(new Error('network down')));
    await saveProgress(failing, save);
    expect(reachability.noteFailure).toHaveBeenCalled();
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

  it('keeps a group no connection takes while an identity move is still on its way', async () => {
    const { setIdentityMovePending } =
      jest.requireActual<typeof import('@/lib/connection-id')>('@/lib/connection-id');
    reachable.mockReturnValue(false);
    const offline = fakeApi(() => Promise.resolve());
    await saveProgress(offline, { ...save, connectionId: 'srv.3', position: 42 });
    reachable.mockReturnValue(true);
    routeClients({}); // the session still shows the old id this launch
    setIdentityMovePending(true);
    try {
      await flushQueue();
      expect(await readQueue()).toEqual([expect.objectContaining({ position: 42 })]);
    } finally {
      setIdentityMovePending(false);
    }
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

  // fe#197: the sync pills read the queue again as it is written, so a drain takes them down.
  it('tells onQueueChange when a save is queued and when a replay drains it', async () => {
    const changes = jest.fn();
    const stop = onQueueChange(changes);
    reachable.mockReturnValue(false);
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      { ...save, connectionId: 'c2' },
    );
    expect(changes).toHaveBeenCalledTimes(1);
    // A newer save of the same book replaces it in place: nothing to read again.
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      { ...save, connectionId: 'c2', position: save.position + 5 },
    );
    expect(changes).toHaveBeenCalledTimes(1);
    routeClients({ c2: fakeApi(() => Promise.resolve()) });
    await flushConnection('c2');
    expect(changes).toHaveBeenCalledTimes(2);
    expect(await readQueue()).toEqual([]);
    stop();
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

  it('a failed save notes the failure against its own connection', async () => {
    reachable.mockReturnValue(true);
    const failing = fakeApi(() => Promise.reject(new Error('server B down')));
    await saveProgress(failing, { ...save, connectionId: 'c2' });
    expect(reachability.noteFailure).toHaveBeenCalledWith('c2', expect.any(Error));
  });

  it('a successful save notes success against its own connection', async () => {
    reachable.mockReturnValue(true);
    const ok = fakeApi(() => Promise.resolve());
    await saveProgress(ok, { ...save, connectionId: 'c2' });
    expect(reachability.noteSuccess).toHaveBeenCalledWith('c2');
  });

  it("loadInitialProgress reports a fetch failure against the book's own connection, as a check request", async () => {
    reachable.mockReturnValue(true);
    const down = fakeGetApi(() => Promise.reject(new Error('server B down')));
    await loadInitialProgress(down, 'c2', 1, 'A/Book');
    // A slow or failed read only asks for a check (frontend#131); it never marks the
    // server down itself.
    expect(reachability.noteFailure).toHaveBeenCalledWith('c2', expect.any(Error));
  });

  it('loadInitialProgress takes an ApiError as an answer from its server', async () => {
    reachable.mockReturnValue(true);
    const answered = fakeGetApi(() => Promise.reject(new ApiError(500, 'boom')));
    await loadInitialProgress(answered, 'c2', 1, 'A/Book');
    expect(reachability.noteSuccess).toHaveBeenCalledWith('c2');
    expect(reachability.noteFailure).not.toHaveBeenCalled();
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

  // The device run: a frozen server held a downloaded book's car start for the whole request
  // timeout, past the car's own wait.
  it("loadInitialProgress: a wait bounds the server's read, then the mirror stands", async () => {
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      { ...save, position: 75 },
    );
    // A frozen server, behind the client's own timeout (which rejects as the client does).
    const frozen = {
      getProgress: jest.fn(
        () =>
          new Promise<Progress | null>((_, reject) => {
            setTimeout(() => reject(new TimeoutError(15_000)), 15_000);
          }),
      ),
    } as unknown as ApiClient;
    jest.useFakeTimers();
    try {
      const lookup = loadInitialProgress(frozen, 'c1', 1, 'A/Book', 3_000);
      await jest.advanceTimersByTimeAsync(3_000);
      const r = await lookup;
      expect(r).toEqual({
        kind: 'progress',
        progress: expect.objectContaining({ position: 75 }),
        unchecked: true,
        late: expect.any(Promise),
      });
      // The slow server is checked at the wait (a `TimeoutError` is what `noteFailure` reads
      // as no answer); the read goes on, and its failure says nothing late.
      expect(reachability.noteFailure).toHaveBeenCalledWith('c1', expect.any(TimeoutError));
      await jest.advanceTimersByTimeAsync(12_000);
      await expect(r.late).resolves.toBeNull();
      // The review: and its late failure asked for a second check of the same server.
      expect(reachability.noteFailure).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  // The review: a server answering after the wait stayed marked as checked (the wait's
  // `noteFailure`), and its row never reached the mirror a later offline start reads.
  it('loadInitialProgress: a late answer says the server is up and writes its row to the mirror', async () => {
    let answer: (p: Progress | null) => void = () => {};
    const slow = {
      getProgress: jest.fn(() => new Promise<Progress | null>((resolve) => (answer = resolve))),
    } as unknown as ApiClient;
    jest.useFakeTimers();
    try {
      const lookup = loadInitialProgress(slow, 'c1', 1, 'A/Book', 3_000);
      await jest.advanceTimersByTimeAsync(3_000);
      const r = await lookup;
      expect(reachability.noteSuccess).not.toHaveBeenCalled();
      answer(
        makeProgress({ position: 400, device_id: 'other', updated_at: '2026-01-02T00:00:00Z' }),
      );
      await expect(r.late).resolves.toMatchObject({ server: { position: 400 } });
      expect(reachability.noteSuccess).toHaveBeenCalledWith('c1');
      expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({
        position: 400,
        device_id: 'other',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  // The review: the late answer said the server was up whatever address had answered, up to
  // the request's timeout after it was sent. One on an address the connection has left since
  // (a home / away switch) says nothing of the address it uses now (fe#147).
  it('loadInitialProgress: a late answer on an address the connection has left says nothing of the server', async () => {
    let answer: (p: Progress | null) => void = () => {};
    const slow = {
      baseUrl: 'http://home.lan:8080',
      getProgress: jest.fn(() => new Promise<Progress | null>((resolve) => (answer = resolve))),
    } as unknown as ApiClient;
    mockResolveClient.mockImplementation(() => ({ baseUrl: 'https://away.example' }));
    jest.useFakeTimers();
    try {
      const lookup = loadInitialProgress(slow, 'c1', 1, 'A/Book', 3_000);
      await jest.advanceTimersByTimeAsync(3_000);
      const r = await lookup;
      answer(
        makeProgress({ position: 400, device_id: 'other', updated_at: '2026-01-02T00:00:00Z' }),
      );
      // Its row is the server's all the same: told, and kept.
      await expect(r.late).resolves.toMatchObject({ server: { position: 400 } });
      expect(reachability.noteSuccess).not.toHaveBeenCalled();
      expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({ position: 400 });
    } finally {
      jest.useRealTimers();
    }
  });

  // The review: a server answering after the wait left the book at this device's older place
  // until the next place check.
  it('loadInitialProgress: a server answering after the wait is told late, with the mirror as it stood', async () => {
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      { ...save, position: 75 },
    );
    let answer: (p: Progress | null) => void = () => {};
    const slow = {
      getProgress: jest.fn(() => new Promise<Progress | null>((resolve) => (answer = resolve))),
    } as unknown as ApiClient;
    jest.useFakeTimers();
    try {
      const lookup = loadInitialProgress(slow, 'c1', 1, 'A/Book', 3_000);
      await jest.advanceTimersByTimeAsync(3_000);
      const r = await lookup;
      expect(r.kind).toBe('progress');
      // The session saves on meanwhile: the late answer keeps the record the start read.
      await saveProgress(
        fakeApi(() => Promise.resolve()),
        { ...save, position: 90 },
      );
      answer(makeProgress({ position: 400, device_id: 'other' }));
      await expect(r.late).resolves.toEqual({
        server: expect.objectContaining({ position: 400 }),
        mirror: expect.objectContaining({ position: 75 }),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  // FE-ANDROID-3: a downloaded book's car start waited 3 s for its item and chapters, then
  // 3 s more for its place, on a frozen server: one wait, not two.
  it('loadInitialProgress: takes the early read, its wait counted from when that read began', async () => {
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      { ...save, position: 75 },
    );
    const frozen = fakeGetApi(() => new Promise<Progress | null>(() => {}));
    jest.useFakeTimers();
    try {
      readPlaceEarly(frozen, 'c1', 1, 'A/Book');
      // The start's item and chapters held it 2.5 s: half a second of the wait is left.
      await jest.advanceTimersByTimeAsync(2_500);
      let done = false;
      const lookup = loadInitialProgress(frozen, 'c1', 1, 'A/Book', 3_000).then((r) => {
        done = true;
        return r;
      });
      await jest.advanceTimersByTimeAsync(499);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(lookup).resolves.toMatchObject({ kind: 'progress', unchecked: true });
      // One read in all: the early one, going on as the late place.
      expect(frozen.getProgress).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('loadInitialProgress: an early read that answered is the place, with no wait at all', async () => {
    const api = fakeGetApi(async () => makeProgress({ position: 60 }));
    jest.useFakeTimers();
    try {
      readPlaceEarly(api, 'c1', 1, 'A/Book');
      await jest.advanceTimersByTimeAsync(5_000);
      const r = await loadInitialProgress(api, 'c1', 1, 'A/Book', 3_000);
      expect(r).toEqual({ kind: 'progress', progress: expect.objectContaining({ position: 60 }) });
      expect(api.getProgress).toHaveBeenCalledTimes(1);
      // Taken once: the next lookup reads afresh.
      await loadInitialProgress(api, 'c1', 1, 'A/Book', 3_000);
      expect(api.getProgress).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('loadInitialProgress: never takes an early read of another address, or one gone stale', async () => {
    const home = fakeGetApi(async () => makeProgress({ position: 10 }));
    const away = fakeGetApi(async () => makeProgress({ position: 20 }), 'https://away.example');
    readPlaceEarly(home, 'c1', 1, 'A/Book');
    const r = await loadInitialProgress(away, 'c1', 1, 'A/Book', 3_000);
    expect(r).toMatchObject({ progress: { position: 20 } });
    jest.useFakeTimers();
    try {
      readPlaceEarly(home, 'c1', 1, 'A/Book');
      await jest.advanceTimersByTimeAsync(EARLY_READ_MS + 1);
      await loadInitialProgress(home, 'c1', 1, 'A/Book', 3_000);
      expect(home.getProgress).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('loadInitialProgress: a lookup with no wait leaves the early read to its start; a clock set back drops it', async () => {
    const api = fakeGetApi(async () => makeProgress({ position: 10 }));
    readPlaceEarly(api, 'c1', 1, 'A/Book');
    // Previously on's lookup (no wait) reads afresh, the early read left for the start.
    await loadInitialProgress(api, 'c1', 1, 'A/Book');
    expect(api.getProgress).toHaveBeenCalledTimes(2);
    await loadInitialProgress(api, 'c1', 1, 'A/Book', 3_000);
    expect(api.getProgress).toHaveBeenCalledTimes(2);
    jest.useFakeTimers();
    try {
      readPlaceEarly(api, 'c1', 1, 'A/Book');
      // The device's clock set back a minute: the read reads as begun in the future.
      jest.setSystemTime(Date.now() - 60_000);
      await loadInitialProgress(api, 'c1', 1, 'A/Book', 3_000);
      expect(api.getProgress).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });

  // A connection signed out before the start took its read: whoever signs in to it next (one
  // with no user id keeps its id) never starts from the read made for the one before.
  it('loadInitialProgress: an early read is dropped with its connection, another one’s kept', async () => {
    const api = fakeGetApi(async () => makeProgress({ position: 10 }));
    readPlaceEarly(api, 'c1', 1, 'A/Book');
    readPlaceEarly(api, 'c2', 1, 'A/Book');
    await removalCleanup('c1');
    await loadInitialProgress(api, 'c1', 1, 'A/Book', 3_000);
    expect(api.getProgress).toHaveBeenCalledTimes(3);
    await loadInitialProgress(api, 'c2', 1, 'A/Book', 3_000);
    expect(api.getProgress).toHaveBeenCalledTimes(3);
  });

  it("loadInitialProgress: a server answering inside the wait is the server's place", async () => {
    const api = fakeGetApi(() => Promise.resolve(makeProgress({ position: 60 })));
    const r = await loadInitialProgress(api, 'c1', 1, 'A/Book', 3_000);
    expect(r).toEqual({ kind: 'progress', progress: expect.objectContaining({ position: 60 }) });
  });

  it('loadInitialProgress: falls back to the mirror when the server is unreachable', async () => {
    // Seed the mirror via a save, then make the fetch throw (offline/5xx).
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      { ...save, position: 75 },
    );
    const api = fakeGetApi(() => Promise.reject(new Error('network down')));
    const r = await loadInitialProgress(api, 'c1', 1, 'A/Book');
    // Not checked against the server: the legacy path guards its saves (fe#198).
    expect(r).toEqual({
      kind: 'progress',
      progress: expect.objectContaining({ position: 75 }),
      unchecked: true,
    });
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

  // --- bookPlace: the book page's place, where Resume plays from (fe#211) ---

  it('bookPlace offline is the mirrored record shaped as Progress', async () => {
    reachable.mockReturnValue(false); // offline: the save only lands in the mirror/queue
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      { ...save, position: 42, finished: true },
    );

    expect(await bookPlace(undefined, 'c1', 1, 'A/Book')).toMatchObject({
      library_id: 1,
      path: 'A/Book',
      position: 42,
      finished: true,
      updated_at: save.updated_at,
    });
  });

  it('bookPlace is null for another connection or an unmirrored book', async () => {
    reachable.mockReturnValue(false);
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      save,
    );

    expect(await bookPlace(undefined, 'c2', 1, 'A/Book')).toBeNull(); // another server
    expect(await bookPlace(undefined, 'c1', 1, 'A/Other')).toBeNull(); // never played
    expect(await bookPlace(null, 'c1', 1, 'A/Other')).toBeNull(); // new on the server too
  });

  // The cold-launch case: the server still has another device's older row (12%), this
  // device played on since. The page shows this device's place, the one Resume plays.
  it("bookPlace takes this device's newer place over another device's older row", async () => {
    await writeMirror({
      ...save,
      position: 900,
      device_id: 'me',
      updated_at: '2026-03-02T00:00:00Z',
      file: 'A/Book/02.mp3',
      file_pos: 300,
    });
    const other = makeProgress({
      position: 120,
      device_id: 'tablet',
      updated_at: '2026-03-01T00:00:00Z',
    });
    const place = await bookPlace(other, 'c1', 1, 'A/Book');
    expect(place).toMatchObject({
      position: 900,
      device_id: 'me',
      file: { path: 'A/Book/02.mp3', pos: 300 },
    });
    // The server's own row goes with it: this device's record reads as version 0 and says
    // nothing of the row's dates or of another device's place to offer.
    expect(place?.server).toBe(other);
    expect(serverRowOf(place as PlacedProgress)).toBe(other);
    // The server's newer row stands, as it does for Resume.
    const newer = makeProgress({ position: 1500, updated_at: '2026-03-03T00:00:00Z' });
    expect(await bookPlace(newer, 'c1', 1, 'A/Book')).toBe(newer);
    expect(serverRowOf(newer)).toBe(newer);
  });
});

describe('withLocalPlaces (fe#211)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  const row = (path: string, p: Partial<Progress> = {}) => ({
    ...makeProgress({ path, ...p }),
    connectionId: 'c1',
    connectionName: 'Home',
  });

  it("puts this device's newer place over a row, newest first again, and keeps the rest", async () => {
    await writeMirror({
      ...save,
      path: 'A/Old',
      position: 70,
      device_id: 'me',
      updated_at: '2026-03-05T00:00:00Z',
    });
    const rows = [
      row('A/New', { position: 20, updated_at: '2026-03-04T00:00:00Z' }),
      row('A/Old', { position: 0, updated_at: '2026-02-01T00:00:00Z' }),
    ];
    const out = withLocalPlaces(rows, await readLocalPlaces());
    expect(out.map((r) => [r.path, r.position, r.connectionName])).toEqual([
      ['A/Old', 70, 'Home'],
      ['A/New', 20, 'Home'],
    ]);
    expect(out[1]).toBe(rows[0]);
  });

  it('is the same list when nothing local is newer, or no places are read yet', async () => {
    const rows = [row('A/Book', { position: 20, updated_at: '2026-03-04T00:00:00Z' })];
    expect(withLocalPlaces(rows, null)).toBe(rows);
    expect(withLocalPlaces(rows, await readLocalPlaces())).toBe(rows);
  });
});

describe('positionOn', () => {
  const files = [
    { rel_path: 'A/Book/02.mp3', duration: 500, seq: 2 },
    { rel_path: 'A/Book/01.mp3', duration: 600, seq: 1 },
  ];

  it('reads a file place on the timeline the files lay out', () => {
    expect(positionOn({ position: 300, file: { path: 'A/Book/02.mp3', pos: 300 } }, files)).toBe(
      900,
    );
    expect(positionOn({ position: 999, file: { path: 'A/Book/01.mp3', pos: 30 } }, files)).toBe(30);
    // Never past the file's end (a file replaced by a shorter one), as a resume lands it.
    expect(positionOn({ position: 999, file: { path: 'A/Book/01.mp3', pos: 700 } }, files)).toBe(
      600,
    );
  });

  it('keeps the whole-book seconds with no file place, an unknown file or an unknown length', () => {
    expect(positionOn({ position: 77 }, files)).toBe(77);
    expect(positionOn({ position: 77, file: { path: 'A/Book/09.mp3', pos: 3 } }, files)).toBe(77);
    expect(positionOn({ position: 77, file: { path: 'A/Book/02.mp3', pos: 3 } }, undefined)).toBe(
      77,
    );
    const unknown = [{ ...files[1], duration: 0 }, files[0]];
    expect(positionOn({ position: 77, file: { path: 'A/Book/02.mp3', pos: 3 } }, unknown)).toBe(77);
  });
});

describe('pendingSaveCount', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('counts the saves waiting in the offline queue, without touching it', async () => {
    expect(await pendingSaveCount()).toBe(0);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([{ path: 'a' }, { path: 'b' }]));
    expect(await pendingSaveCount()).toBe(2);
    expect(JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) ?? '[]')).toHaveLength(2);
  });

  // The player's sync line is about the playing book's server: another server's backlog
  // made it say "Saved on this device".
  it("counts one connection's saves when asked", async () => {
    await AsyncStorage.setItem(
      QUEUE_KEY,
      JSON.stringify([
        { connectionId: 'c1', path: 'a' },
        { connectionId: 'c2', path: 'b' },
        { connectionId: 'c2', path: 'c' },
      ]),
    );
    expect(await pendingSaveCount('c1')).toBe(1);
    expect(await pendingSaveCount('c2')).toBe(2);
    expect(await pendingSaveCount('c3')).toBe(0);
    expect(await pendingSaveCount()).toBe(3);
  });
});

describe('readLocalPlaces / resumeLookupOf', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  const at = (updated_at: string, position: number) => ({ ...save, updated_at, position });

  it('chooses live and mirrored server rows against captures on the device clock, including ties', () => {
    const local = at('2026-01-02T00:00:10Z', 75);
    const row = makeProgress({ position: 150, updated_at: '2026-01-02T00:00:20Z' });
    const places: LocalPlaces = {
      mirror: { 'c1:1:A/Book': local },
      queue: [],
      pending: new Set(),
      skews: { c1: 20_000 },
    };
    const lookup = () => resumeLookupOf(row, places, 'c1', 1, 'A/Book');
    expect(lookup()).toMatchObject({ progress: { position: 75 }, unchecked: true });
    places.skews = { c1: 10_000 };
    expect(lookup()).toMatchObject({ progress: row });
    places.skews = { c1: -20_000 };
    places.mirror['c1:1:A/Book'] = at('2026-01-02T00:00:30Z', 75);
    expect(lookup()).toMatchObject({ progress: row });

    // The mirror holds the server's row. A queued capture with the same raw timestamp
    // still took place later here, and the car gets that capture's device time.
    places.mirror['c1:1:A/Book'] = progressToSave('c1', 1, 'A/Book', row);
    places.queue = [at(row.updated_at, 90)];
    places.skews = { c1: 20_000 };
    const queued = resumeLookupOf(undefined, places, 'c1', 1, 'A/Book');
    expect(queued).toMatchObject({ progress: { position: 90 } });
    expect(placeSavedAt(queued, undefined, places, 'c1', 1, 'A/Book')).toBe(
      Date.parse(row.updated_at),
    );
  });

  it('compares a previously acknowledged finish with the local restart on the same clock', () => {
    const row = makeProgress({
      finished: true,
      version: 5,
      updated_at: '2026-01-02T00:00:20Z',
      finished_at: '2026-01-02T00:00:19Z',
    });
    const mine = { ...at('2026-01-02T00:00:05Z', 20), ack_version: 5 };
    const places = {
      mirror: { 'c1:1:A/Book': mine },
      queue: [],
      pending: new Set<string>(),
      skews: { c1: 20_000 },
    };
    expect(resumeLookupOf(row, places, 'c1', 1, 'A/Book')).toMatchObject({
      progress: { finished: false, position: 20 },
    });
  });

  it('resolves each book from the mirror and the queue read once', async () => {
    await AsyncStorage.setItem(
      MIRROR_KEY,
      JSON.stringify({ 'c1:1:A/Book': at('2026-01-02T00:00:00Z', 20) }),
    );
    await AsyncStorage.setItem(
      QUEUE_KEY,
      JSON.stringify([{ ...at('2026-01-03T00:00:00Z', 30), path: 'B' }]),
    );
    const places = await readLocalPlaces();

    // The mirror's place is newer than the server's row.
    expect(resumeLookupOf(makeProgress({ position: 10 }), places, 'c1', 1, 'A/Book')).toMatchObject(
      { kind: 'progress', progress: { position: 20 } },
    );
    // A queued save stands in for an unreached server.
    expect(resumeLookupOf(undefined, places, 'c1', 1, 'B')).toMatchObject({
      kind: 'progress',
      progress: { path: 'B', position: 30 },
    });
    // Nothing anywhere: new when the server answered, unknown when it was not reached.
    expect(resumeLookupOf(null, places, 'c1', 1, 'C')).toEqual({ kind: 'empty' });
    expect(resumeLookupOf(undefined, places, 'c1', 1, 'C')).toEqual({ kind: 'failed' });
    // Another server's record of the same path is not this book's.
    expect(resumeLookupOf(undefined, places, 'c2', 1, 'A/Book')).toEqual({ kind: 'failed' });
  });

  it('a newer server row wins over the device', async () => {
    await AsyncStorage.setItem(
      MIRROR_KEY,
      JSON.stringify({ 'c1:1:A/Book': at('2026-01-02T00:00:00Z', 20) }),
    );
    const row = makeProgress({ position: 70, updated_at: '2026-02-01T00:00:00Z' });
    expect(resumeLookupOf(row, await readLocalPlaces(), 'c1', 1, 'A/Book')).toEqual({
      kind: 'progress',
      progress: row,
    });
  });
});

// FE-13: Android's car snapshot carries it, and the engine's live place wins only when newer.
describe('placeSavedAt', () => {
  const capture = (updated_at: string, position: number): ProgressSave => ({
    connectionId: 'c1',
    libraryId: 1,
    path: 'A/Book',
    position,
    duration: 3600,
    finished: false,
    playback_speed: 1,
    device_id: 'me',
    updated_at,
  });
  const savedAt = (server: Progress | null | undefined, mirror?: ProgressSave, skew = 0) => {
    const places: LocalPlaces = {
      mirror: mirror ? { 'c1:1:A/Book': mirror } : {},
      queue: [],
      pending: new Set<string>(),
      skews: { c1: skew },
    };
    const lookup = resumeLookupOf(server, places, 'c1', 1, 'A/Book');
    return placeSavedAt(lookup, server, places, 'c1', 1, 'A/Book');
  };

  it("is the server row's time by this device's clock, its skew taken off", () => {
    const row = makeProgress({ position: 3000, updated_at: '2026-01-02T00:00:00.000Z' });
    expect(savedAt(row, undefined, 60_000)).toBe(Date.parse('2026-01-02T00:00:00.000Z') - 60_000);
  });

  it("is a capture's own time, and a server's row the mirror holds by its server's clock", () => {
    const mine = capture('2026-01-03T00:00:00.000Z', 20);
    expect(savedAt(null, mine, 60_000)).toBe(Date.parse(mine.updated_at));
    const kept = { ...mine, server_clock: true as const };
    expect(savedAt(undefined, kept, 60_000)).toBe(Date.parse(mine.updated_at) - 60_000);
  });

  it('is nothing with no place, or an unreadable stamp', () => {
    expect(savedAt(null)).toBeUndefined();
    expect(savedAt(undefined)).toBeUndefined();
    expect(savedAt(makeProgress({ updated_at: 'never' }))).toBeUndefined();
  });
});

describe('the file place (fe#188) and the Sync v2 mirror fields', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  /** Another tab: its own copy of the module (its own memory) over the same storage. */
  const otherTab = () => {
    let other!: typeof import('@/playback/progress-sync');
    jest.isolateModules(() => {
      jest.doMock('@react-native-async-storage/async-storage', () => ({
        __esModule: true,
        default: AsyncStorage,
      }));
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      other = require('@/playback/progress-sync') as typeof import('@/playback/progress-sync');
    });
    return other;
  };

  const filed = {
    ...save,
    position: 3600,
    file: 'A/Book/02.mp3',
    file_pos: 600,
    updated_at: '2026-01-02T00:00:00Z',
  };

  it("resume carries this device's file place with its own newest save", async () => {
    await AsyncStorage.setItem(MIRROR_KEY, JSON.stringify({ 'c1:1:A/Book': filed }));
    expect(resumeLookupOf(undefined, await readLocalPlaces(), 'c1', 1, 'A/Book')).toEqual({
      kind: 'progress',
      progress: expect.objectContaining({ position: 3600 }),
      file: { path: 'A/Book/02.mp3', pos: 600 },
      unchecked: true,
    });
  });

  it("the server's echo of this device's save keeps the file place; another device's does not", async () => {
    await AsyncStorage.setItem(MIRROR_KEY, JSON.stringify({ 'c1:1:A/Book': filed }));
    const places = await readLocalPlaces();
    // The server moved the seconds to its own file order: still this device's save.
    // Stamped with the span's end in server time, a moment after the capture.
    const echo = makeProgress({
      position: 4100,
      device_id: 'dev',
      updated_at: '2026-01-02T00:00:02Z',
    });
    expect(resumeLookupOf(echo, places, 'c1', 1, 'A/Book')).toMatchObject({
      file: { path: 'A/Book/02.mp3', pos: 600 },
    });
    const other = makeProgress({
      position: 9000,
      device_id: 'phone',
      updated_at: '2026-01-03T00:00:00Z',
    });
    expect(resumeLookupOf(other, places, 'c1', 1, 'A/Book')).not.toHaveProperty('file');
  });

  it("a place this device reset since (Mark not finished) does not keep the end's file place", async () => {
    // Finished here: the mirror's file place is the last file's end.
    await writeMirror({
      ...filed,
      position: 100,
      finished: true,
      file: 'A/Book/03.mp3',
      file_pos: 590,
    });
    // Marked not finished: the row keeps this device as its writer, its place back at 0.
    const reset = makeProgress({
      position: 0,
      finished: false,
      version: 6,
      updated_at: '2026-01-03T00:00:00Z',
    });
    const r = await loadInitialProgress(
      fakeGetApi(async () => reset),
      'c1',
      1,
      'A/Book',
    );
    expect(r).toMatchObject({ kind: 'progress', progress: { position: 0, finished: false } });
    expect(r).not.toHaveProperty('file');
    expect(await readMirrorOf('c1', 1, 'A/Book')).not.toHaveProperty('file');
  });

  it('writeMirror keeps ack_version, answered and the file place across a same-place record', async () => {
    await writeMirror({ ...filed, ack_version: 7, answered: ['phone|x'] });
    await writeMirror({ ...save, position: 3600, updated_at: '2026-01-03T00:00:00Z' });
    expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({
      ack_version: 7,
      answered: ['phone|x'],
      file: 'A/Book/02.mp3',
      file_pos: 600,
    });
    // Another device's place elsewhere drops the file place.
    await writeMirror({
      ...save,
      position: 9000,
      device_id: 'phone',
      updated_at: '2026-01-04T00:00:00Z',
    });
    const m = await readMirrorOf('c1', 1, 'A/Book');
    expect(m).not.toHaveProperty('file');
    expect(m?.ack_version).toBe(7);
  });

  // A finish never queued on a book with no record before it (`recordFinish`): its record
  // goes, and only the book's.
  it('updateMirror removes a record changed to null', async () => {
    await writeMirror({ ...save, finished: true, updated_at: '2026-01-04T00:00:00Z' });
    await writeMirror({ ...save, path: 'B/Book', updated_at: '2026-01-04T00:00:00Z' });
    await updateMirror('c1', 1, 'A/Book', () => null);
    expect(await readMirrorOf('c1', 1, 'A/Book')).toBeNull();
    expect(await readMirrorOf('c1', 1, 'B/Book')).toMatchObject({ path: 'B/Book' });
  });

  // fe#258 (fe#272's partial fix): a read of the server's row on its way as the Undo was
  // made landed after it with the finished row, stamped later than the record the Undo put
  // back, and finished the mirror again.
  describe('a finish undone here (noteUndoneFinish)', () => {
    const undoneAt = Date.parse('2026-01-05T00:00:00Z');
    const unfinished = { ...save, position: 48, updated_at: '2026-01-04T00:00:00.001Z' };
    const finishedRow = { ...save, position: 100, finished: true, server_clock: true as const };

    it('holds off a finished record stamped before the Undo, not one after it', async () => {
      await writeMirror(unfinished);
      await noteUndoneFinish('c1', 1, 'A/Book', undoneAt);
      const now = jest.spyOn(Date, 'now').mockReturnValue(undoneAt + 5_000);
      try {
        await writeMirror({ ...finishedRow, updated_at: '2026-01-04T23:59:59Z' });
        expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({ finished: false });
        // A place, unfinished, goes in as ever; so does a finish made after the Undo.
        await writeMirror({ ...save, position: 60, updated_at: '2026-01-04T23:59:59Z' });
        expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({ position: 60 });
        await writeMirror({ ...finishedRow, updated_at: '2026-01-05T00:00:01Z' });
        expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({ finished: true });
      } finally {
        now.mockRestore();
      }
    });

    it('only for a while: past the hold the newest record wins again', async () => {
      await writeMirror(unfinished);
      await noteUndoneFinish('c1', 1, 'A/Book', undoneAt);
      const now = jest.spyOn(Date, 'now').mockReturnValue(undoneAt + 61_000);
      try {
        await writeMirror({ ...finishedRow, updated_at: '2026-01-04T23:59:59Z' });
        expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({ finished: true });
      } finally {
        now.mockRestore();
      }
    });

    // The clock set back since the Undo (a stored hold outlives a reload): a hold dated
    // ahead of now held every finish off until the clock caught up.
    it('forgets a hold dated ahead of now', async () => {
      await writeMirror(unfinished);
      await noteUndoneFinish('c1', 1, 'A/Book', undoneAt);
      const now = jest.spyOn(Date, 'now').mockReturnValue(undoneAt - 10 * 60_000);
      try {
        await writeMirror({ ...finishedRow, updated_at: '2026-01-04T23:59:59Z' });
        expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({ finished: true });
      } finally {
        now.mockRestore();
      }
    });

    // Web: every tab writes the one mirror, and a hold in the Undo's tab alone let another
    // tab's read of the finished row finish it again.
    it("holds off another tab's finished record too", async () => {
      await writeMirror(unfinished);
      const other = otherTab();
      await noteUndoneFinish('c1', 1, 'A/Book', undoneAt);
      const now = jest.spyOn(Date, 'now').mockReturnValue(undoneAt + 5_000);
      try {
        await other.writeMirror({ ...finishedRow, updated_at: '2026-01-04T23:59:59Z' });
        expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({ finished: false });
        // Past the hold there too, the newest record wins again.
        now.mockReturnValue(undoneAt + 61_000);
        await other.writeMirror({ ...finishedRow, updated_at: '2026-01-04T23:59:59Z' });
        expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({ finished: true });
      } finally {
        now.mockRestore();
      }
    });

    it("another book's finished record is not held off", async () => {
      await noteUndoneFinish('c1', 1, 'A/Book', undoneAt);
      const now = jest.spyOn(Date, 'now').mockReturnValue(undoneAt + 5_000);
      try {
        await writeMirror({ ...finishedRow, path: 'B/Book', updated_at: '2026-01-04T00:00:00Z' });
        expect(await readMirrorOf('c1', 1, 'B/Book')).toMatchObject({ finished: true });
      } finally {
        now.mockRestore();
      }
    });
  });

  // Web: the tabs write one mirror, each reading it whole and writing it back. With a lock
  // per tab, two tabs both read it before either wrote, and the later write lost the other
  // tab's record.
  describe('two tabs writing the mirror at once', () => {
    const nav = globalThis.navigator as { locks?: unknown };
    afterEach(() => {
      delete nav.locks;
    });

    it("never writes over the other tab's record (the browser's Web Locks)", async () => {
      // One browser's Web Locks: a job per name at a time, whichever tab asks.
      const chains = new Map<string, Promise<unknown>>();
      const request = (name: string, job: () => Promise<unknown>) => {
        const run = (chains.get(name) ?? Promise.resolve()).then(job);
        chains.set(
          name,
          run.catch(() => undefined),
        );
        return run;
      };
      Object.defineProperty(nav, 'locks', { configurable: true, value: { request } });
      const other = otherTab();
      await Promise.all([
        writeMirror({ ...save, path: 'A/One' }),
        other.writeMirror({ ...save, path: 'B/Two' }),
        updateMirror('c1', 1, 'C/Three', (r) => r, makeProgress({ position: 7 })),
        other.writeMirror({ ...save, path: 'D/Four' }),
      ]);
      for (const path of ['A/One', 'B/Two', 'C/Three', 'D/Four']) {
        expect(await readMirrorOf('c1', 1, path)).not.toBeNull();
      }
    });
  });

  // fe#208: the echo is stamped in server time, the capture in this device's time.
  describe("a device whose clock is behind the server's", () => {
    // The stored skews come from the outbox, their one reader (fe#211): a stand-in here.
    let stored: Record<string, number> = {};
    beforeAll(() => provideStoredSkews(async () => stored));
    afterAll(() => provideStoredSkews(null));
    beforeEach(() => {
      stored = {};
    });
    afterEach(() => noteClockSkew('c1', 0));
    // 20 s slow: the server stamps its echo of the 00:00:00 capture 00:00:22.
    const echo = makeProgress({
      position: 4100,
      device_id: 'dev',
      updated_at: '2026-01-02T00:00:22Z',
    });

    it('keeps its file place once a sync answer measured the skew (stored)', async () => {
      await AsyncStorage.setItem(MIRROR_KEY, JSON.stringify({ 'c1:1:A/Book': filed }));
      expect(resumeLookupOf(echo, await readLocalPlaces(), 'c1', 1, 'A/Book')).not.toHaveProperty(
        'file',
      );
      stored = { c1: 20_000 };
      expect(resumeLookupOf(echo, await readLocalPlaces(), 'c1', 1, 'A/Book')).toMatchObject({
        file: { path: 'A/Book/02.mp3', pos: 600 },
      });
    });

    it("this launch's measurement counts too, and writeMirror's merge keeps it", async () => {
      await AsyncStorage.setItem(MIRROR_KEY, JSON.stringify({ 'c1:1:A/Book': filed }));
      noteClockSkew('c1', 20_000);
      expect(resumeLookupOf(echo, await readLocalPlaces(), 'c1', 1, 'A/Book')).toMatchObject({
        file: { path: 'A/Book/02.mp3', pos: 600 },
      });
      await writeMirror(progressToSave('c1', 1, 'A/Book', echo));
      expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({ file: 'A/Book/02.mp3' });
    });

    it('a server behind the device widens nothing: its echo comes before the capture', async () => {
      await AsyncStorage.setItem(MIRROR_KEY, JSON.stringify({ 'c1:1:A/Book': filed }));
      noteClockSkew('c1', -20_000);
      // A row 22 s after the capture by a server 20 s behind is 42 s newer: the mirror lost
      // writes, and its file place is stale.
      expect(resumeLookupOf(echo, await readLocalPlaces(), 'c1', 1, 'A/Book')).not.toHaveProperty(
        'file',
      );
    });

    it('drops a stale file place when a slow server stamps its newer row before the capture', async () => {
      await AsyncStorage.setItem(MIRROR_KEY, JSON.stringify({ 'c1:1:A/Book': filed }));
      noteClockSkew('c1', -20_000);
      const row = { ...echo, updated_at: '2026-01-01T23:59:55Z' }; // 00:00:15 here
      const lookup = await loadInitialProgress(
        fakeGetApi(async () => row),
        'c1',
        1,
        'A/Book',
      );
      expect(lookup).toMatchObject({ progress: row });
      expect(lookup).not.toHaveProperty('file');
      expect(await readMirrorOf('c1', 1, 'A/Book')).not.toHaveProperty('file');
    });

    it('a cold launch merges with the stored skew before any sync answer', async () => {
      const cid = 'c-cold';
      const mine = { ...filed, connectionId: cid };
      await AsyncStorage.setItem(MIRROR_KEY, JSON.stringify({ [`${cid}:1:A/Book`]: mine }));
      stored = { [cid]: 20_000 };
      const r = await loadInitialProgress(
        fakeGetApi(async () => echo),
        cid,
        1,
        'A/Book',
      );
      expect(r).toMatchObject({ file: { path: 'A/Book/02.mp3', pos: 600 } });
      expect(await readMirrorOf(cid, 1, 'A/Book')).toMatchObject({ file: 'A/Book/02.mp3' });
    });

    it('concurrent cold checks both await the same stored skew', async () => {
      const cid = 'c-concurrent-skew';
      let release!: (values: Record<string, number>) => void;
      const read = jest.fn(
        () => new Promise<Record<string, number>>((resolve) => (release = resolve)),
      );
      provideStoredSkews(read);
      try {
        const first = knownSkew(cid);
        const second = knownSkew(cid);
        release({ [cid]: 20_000 });
        expect(await Promise.all([first, second])).toEqual([20_000, 20_000]);
        expect(read).toHaveBeenCalledTimes(1);
      } finally {
        provideStoredSkews(async () => stored);
      }
    });

    // fe#259: keep-newest compared the server's stamp with this device's, so with the
    // server's clock S ahead a row read back hid this device's own captures for S.
    it("keeps this device's capture made after a server row by this device's clock", async () => {
      noteClockSkew('c1', 20_000);
      await writeMirror(progressToSave('c1', 1, 'A/Book', echo)); // 00:00:02 here
      await writeMirror({ ...save, position: 4200, updated_at: '2026-01-02T00:00:05Z' });
      expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({ position: 4200 });
      expect(await readMirrorOf('c1', 1, 'A/Book')).not.toHaveProperty('server_clock');
    });

    it('a server row newer by its own clock than the capture still replaces it', async () => {
      noteClockSkew('c1', 20_000);
      await writeMirror({ ...save, position: 4000, updated_at: '2026-01-02T00:00:01Z' });
      await writeMirror(progressToSave('c1', 1, 'A/Book', echo)); // 00:00:02 here
      expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({
        position: 4100,
        server_clock: true,
      });
    });

    it("a server behind: its row after the capture by this device's clock wins", async () => {
      noteClockSkew('c1', -20_000);
      await writeMirror({ ...save, position: 4000, updated_at: '2026-01-02T00:00:30Z' });
      await writeMirror(progressToSave('c1', 1, 'A/Book', echo)); // 00:00:42 here
      expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({ position: 4100 });
    });

    // The place the app has cached against the mirror (`knownProgress` in the store): an
    // explicit start reads the book's speed and its finish from the newer of the two.
    describe('mirrorIsNewest', () => {
      const capture = { ...save, position: 4200, updated_at: '2026-01-02T00:00:05Z' };
      // The server's own row: it has a version.
      const row = makeProgress({ ...echo, version: 7 });

      it("a capture made after the server's row by this device's clock is the newest", async () => {
        // The row is 00:00:02 here: raw, its 00:00:22 stamp hid the 00:00:05 capture.
        expect(await mirrorIsNewest(capture, row)).toBe(false);
        noteClockSkew('c1', 20_000);
        expect(await mirrorIsNewest(capture, row)).toBe(true);
        // A row after the capture by this device's clock too still wins.
        const later = makeProgress({ ...row, updated_at: '2026-01-02T00:00:30Z' });
        expect(await mirrorIsNewest(capture, later)).toBe(false);
      });

      it("a record of this device's (the server's row beside it) is on this device's clock", async () => {
        noteClockSkew('c1', 20_000);
        const mine: PlacedProgress = { ...row, version: 0, server: row };
        expect(await mirrorIsNewest(capture, mine)).toBe(false);
        // The mirror's own copy of the server's row, against that row: the same record.
        expect(await mirrorIsNewest(progressToSave('c1', 1, 'A/Book', row), row)).toBe(true);
      });

      it("a place read offline from the mirror's copy of a server row never hides a later capture", async () => {
        noteClockSkew('c1', 20_000);
        // The mirror held the server's row (00:00:02 here), and the book's page read it with
        // its server away: a place with no version, stamped 00:00:22.
        await writeMirror(progressToSave('c1', 1, 'A/Book', row));
        const offline = (await bookPlace(undefined, 'c1', 1, 'A/Book'))!;
        expect(offline).toMatchObject({ version: 0, updated_at: echo.updated_at });
        expect(offline).not.toHaveProperty('server');
        // Then a speed chosen offline, 00:00:05 here: the mirror takes it, and it is the newest.
        await writeMirror({ ...capture, playback_speed: 1.5 });
        const mirror = (await readMirrorOf('c1', 1, 'A/Book'))!;
        expect(mirror).toMatchObject({ playback_speed: 1.5 });
        expect(await mirrorIsNewest(mirror, offline)).toBe(true);
        // With no skew known the stamps stand as they are.
        noteClockSkew('c1', 0);
        expect(await mirrorIsNewest(mirror, offline)).toBe(false);
      });
    });

    it('still drops a file place older than the skew allows', async () => {
      await AsyncStorage.setItem(MIRROR_KEY, JSON.stringify({ 'c1:1:A/Book': filed }));
      noteClockSkew('c1', 20_000);
      const later = makeProgress({ ...echo, updated_at: '2026-01-02T00:01:00Z' });
      expect(resumeLookupOf(later, await readLocalPlaces(), 'c1', 1, 'A/Book')).not.toHaveProperty(
        'file',
      );
    });
  });

  it('ignoreOffer notes the offer without acknowledging anything', async () => {
    await writeMirror({ ...save, ack_version: 3 });
    const row = makeProgress({ version: 9 });
    await ignoreOffer('c1', 1, 'A/Book', row, 'watch|a');
    await ignoreOffer('c1', 1, 'A/Book', row, 'watch|a');
    expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({
      ack_version: 3,
      ignored: ['watch|a'],
    });
    await writeMirror({ ...save, updated_at: '2026-02-01T00:00:00Z' });
    const mirror = await readMirrorOf('c1', 1, 'A/Book');
    expect(mirror?.ignored).toEqual(['watch|a']);
    expect(mirror?.answered).toBeUndefined();
  });

  it('ackVersion never lowers; it creates the record from the row when none exists', async () => {
    const row = makeProgress({ position: 50, version: 4 });
    await ackVersion('c1', 1, 'A/Book', 4, row);
    expect((await readMirrorOf('c1', 1, 'A/Book'))?.ack_version).toBe(4);
    await ackVersion('c1', 1, 'A/Book', 2);
    expect((await readMirrorOf('c1', 1, 'A/Book'))?.ack_version).toBe(4);
    await ackVersion('c1', 1, 'A/Book', 9);
    expect((await readMirrorOf('c1', 1, 'A/Book'))?.ack_version).toBe(9);
    // No record and no row: nothing.
    await ackVersion('c1', 1, 'Else', 3);
    expect(await readMirrorOf('c1', 1, 'Else')).toBeNull();
  });

  it('answerOffer acknowledges the row (never lower) and notes each offer once, the newest 20', async () => {
    await writeMirror(save);
    const row = makeProgress({ version: 5 });
    await answerOffer('c1', 1, 'A/Book', row, 'phone|a');
    await answerOffer('c1', 1, 'A/Book', row, 'phone|a');
    expect((await readMirrorOf('c1', 1, 'A/Book'))?.answered).toEqual(['phone|a']);
    expect((await readMirrorOf('c1', 1, 'A/Book'))?.ack_version).toBe(5);
    await ackVersion('c1', 1, 'A/Book', 9);
    for (let i = 0; i < 25; i++) await answerOffer('c1', 1, 'A/Book', row, `k${i}`);
    const m = await readMirrorOf('c1', 1, 'A/Book');
    expect(m?.answered).toHaveLength(20);
    expect(m?.answered?.[19]).toBe('k24');
    expect(m?.ack_version).toBe(9);
  });
});

describe('resume against a newer server row (live verification F1, F2)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it("a stale file place of this device's never takes it back from its own newer row", async () => {
    // The browser lost its last 90 s of writes: the mirror is 90 s behind its own row.
    const stale = {
      ...save,
      position: 16890.6,
      file: 'A/Book/10.mp3',
      file_pos: 689.3,
      updated_at: '2026-10-30T12:00:00.000Z',
    };
    await AsyncStorage.setItem(MIRROR_KEY, JSON.stringify({ 'c1:1:A/Book': stale }));
    const row = makeProgress({
      position: 16980.6,
      version: 40,
      device_id: 'dev',
      updated_at: '2026-10-30T12:01:30.000Z',
    });
    const api = fakeGetApi(async () => row);
    const r = await loadInitialProgress(api, 'c1', 1, 'A/Book');
    expect(r).toEqual({ kind: 'progress', progress: row });
    // Nor does the mirror carry the stale file place onto the row.
    expect(await readMirrorOf('c1', 1, 'A/Book')).not.toHaveProperty('file');
  });

  const finishedRow = (over: Partial<Progress> = {}) =>
    makeProgress({
      position: 100,
      finished: true,
      version: 9,
      device_id: 'phone',
      updated_at: '2026-10-30T03:06:39.000Z',
      finished_at: '2026-10-30T03:05:00.000Z',
      ...over,
    });
  const mine = (over: Partial<ProgressSave> = {}): ProgressSave => ({
    ...save,
    position: 59.6,
    updated_at: '2026-10-30T03:07:31.000Z',
    ack_version: 7,
    ...over,
  });
  const lookup = async (row: Progress, mirror: ProgressSave, pending?: Set<string>) => {
    await AsyncStorage.setItem(MIRROR_KEY, JSON.stringify({ 'c1:1:A/Book': mirror }));
    const places = await readLocalPlaces();
    return resumeLookupOf(
      row,
      { ...places, pending: pending ?? places.pending },
      'c1',
      1,
      'A/Book',
    );
  };

  it("another device's finish this device never saw wins over its newer unfinished place", async () => {
    expect(await lookup(finishedRow(), mine())).toEqual({
      kind: 'progress',
      progress: finishedRow(),
    });
  });

  it('a finish newer than this device place wins even when its version was seen', async () => {
    const row = finishedRow({ version: 7, finished_at: '2026-10-30T03:08:00.000Z' });
    expect(await lookup(row, mine())).toMatchObject({ progress: { finished: true } });
  });

  it("this device's own later place stands when it saw the finished row (its own restart)", async () => {
    expect(await lookup(finishedRow(), mine({ ack_version: 9 }))).toMatchObject({
      progress: { finished: false, position: 59.6 },
    });
  });

  it("this device's own place stands while its events wait to be sent", async () => {
    const r = await lookup(finishedRow(), mine(), new Set(['c1:1:A/Book']));
    expect(r).toMatchObject({ progress: { finished: false, position: 59.6 } });
  });

  it("this device's queued save stands though the mirror holds the same capture", async () => {
    // A legacy capture writes the mirror and the queue with one `updated_at`: the tie picks
    // the mirror's record, and the queued save is still on its way.
    const queued = mine();
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([queued]));
    expect(await lookup(finishedRow(), queued)).toMatchObject({
      progress: { finished: false, position: 59.6 },
    });
  });

  it('readLocalPlaces names the books with events waiting', async () => {
    await AsyncStorage.setItem(
      'audiosilo.listeningOutbox',
      JSON.stringify([
        { connectionId: 'c1', event: { id: 'a', kind: 'listen', library_id: 1, path: 'A/Book' } },
      ]),
    );
    expect((await readLocalPlaces()).pending).toEqual(new Set(['c1:1:A/Book']));
  });
});

// fe#198: the legacy PUT is last-write-wins by updated_at, so a session that began where
// this device could not check its server must not move another device's further place back.
describe('the replay guard on the legacy PUT path (fe#198)', () => {
  /** Another device's place far ahead on the server (Death Masks at 70%). */
  const ahead = makeProgress({
    position: 3570,
    duration: 5100,
    device_id: 'phone',
    updated_at: '2025-12-31T20:00:00Z',
    version: 7,
  });
  /** This device's offline session: 4.78 s in, newer by the clock. */
  const guarded: ProgressSave = { ...save, position: 4.78, duration: 5100, guard: true };
  const held: [ProgressSave, Progress][] = [];
  let stopHeld: () => void = () => {};

  /** A client whose GET answers `row` and whose PUT resolves (or `put` decides). */
  function serverWith(row: Progress | null | (() => Promise<Progress | null>)) {
    return {
      getProgress: jest.fn(typeof row === 'function' ? row : async () => row),
      saveProgress: jest.fn(async () => {}),
    } as unknown as ApiClient & { getProgress: jest.Mock; saveProgress: jest.Mock };
  }

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    reachable.mockReset().mockReturnValue(true);
    mockResolveClient.mockReset().mockReturnValue(null);
    mockSessionReady.mockReset().mockReturnValue(true);
    held.length = 0;
    stopHeld = onHeldSave((s, row) => held.push([s, row]));
  });
  afterEach(() => stopHeld());

  describe('guardHolds (the rule)', () => {
    it("holds for another device's unanswered place more than 30 s further on", () => {
      expect(guardHolds(guarded, ahead)).toBe(true);
    });

    it("lets through this device's own row, a near place, a finish, an answered place, no row", () => {
      expect(guardHolds(guarded, { ...ahead, device_id: 'dev' })).toBe(false);
      expect(guardHolds(guarded, { ...ahead, position: 30 })).toBe(false);
      expect(guardHolds(guarded, { ...ahead, finished: true })).toBe(false);
      expect(guardHolds({ ...guarded, finished: true }, ahead)).toBe(false);
      expect(guardHolds(guarded, ahead, ['phone|2025-12-31T20:00:00Z'])).toBe(false);
      expect(guardHolds(guarded, ahead, ['phone|another time'])).toBe(true);
      expect(guardHolds(guarded, null)).toBe(false);
      expect(guardHolds(guarded, { ...ahead, device_id: '' })).toBe(false);
    });
  });

  it("a live guarded save against a further place: no PUT, held, the mirror keeps this device's", async () => {
    const api = serverWith(ahead);
    await expect(saveProgress(api, guarded)).resolves.toBe('held');
    expect(api.saveProgress).not.toHaveBeenCalled();
    expect(held).toEqual([[guarded, ahead]]);
    expect(await readQueue()).toEqual([guarded]);
    const mirrored = await readMirrorOf('c1', 1, 'A/Book');
    expect(mirrored).toMatchObject({ position: 4.78 });
    expect(mirrored).not.toHaveProperty('guard'); // never kept in the mirror
  });

  it('a listener that throws leaves the save held for a later choice', async () => {
    const stop = onHeldSave(() => {
      throw new Error('listener broke');
    });
    try {
      const api = serverWith(ahead);
      await expect(saveProgress(api, guarded)).resolves.toBe('held');
      expect(await readQueue()).toEqual([guarded]);
    } finally {
      stop();
    }
  });

  it('a live guarded save goes through when nothing is further on, and says so', async () => {
    const api = serverWith(makeProgress({ position: 2, device_id: 'phone' }));
    await expect(saveProgress(api, guarded)).resolves.toBe('saved');
    expect(api.saveProgress).toHaveBeenCalledWith(
      1,
      'A/Book',
      expect.objectContaining({ position: 4.78, version: 0 }),
    );
    expect(held).toEqual([]);
  });

  it('after Stay (the place answered), the guarded save goes through', async () => {
    await writeMirror({ ...save, answered: ['phone|2025-12-31T20:00:00Z'] });
    const api = serverWith(ahead);
    await expect(saveProgress(api, guarded)).resolves.toBe('saved');
    expect(api.saveProgress).toHaveBeenCalled();
  });

  it('reuses a hold across foreground and background saves, then checks again after two minutes', async () => {
    const session = { ...guarded, guard_session: 'still-playing' };
    const api = serverWith(ahead);
    const now = jest.spyOn(Date, 'now');
    const start = Date.now();
    try {
      now.mockReturnValue(start);
      await expect(saveProgress(api, session)).resolves.toBe('held');
      now.mockReturnValue(start + 15_000);
      const later = { ...session, position: 18 };
      await expect(saveProgress(api, later)).resolves.toBe('held');
      expect(api.getProgress).toHaveBeenCalledTimes(1);
      expect(held).toEqual([
        [session, ahead],
        [later, ahead],
      ]);
      now.mockReturnValue(start + 60_000);
      await expect(saveProgress(api, later)).resolves.toBe('held');
      expect(api.getProgress).toHaveBeenCalledTimes(1);
      // The other device has since restarted.
      api.getProgress.mockResolvedValue(null);
      now.mockReturnValue(start + 120_000);
      await expect(saveProgress(api, later)).resolves.toBe('saved');
      expect(api.getProgress).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('checks again when catching up or answering: the other device may have moved on', async () => {
    const session = { ...guarded, guard_session: 'catching-up' };
    const api = serverWith(ahead);
    await expect(saveProgress(api, session)).resolves.toBe('held');
    const further = {
      ...ahead,
      position: ahead.position + 100,
      updated_at: '2026-01-01T02:00:00Z',
    };
    api.getProgress.mockResolvedValue(further);
    await expect(saveProgress(api, { ...session, position: ahead.position })).resolves.toBe('held');
    expect(api.saveProgress).not.toHaveBeenCalled();
    await answerOffer('c1', 1, 'A/Book', further, `${further.device_id}|${further.updated_at}`);
    await expect(saveProgress(api, session)).resolves.toBe('saved');
    expect(api.getProgress).toHaveBeenCalledTimes(3);
  });

  it('a fresh session looks up the book even while the previous session is held', async () => {
    const api = serverWith(ahead);
    await saveProgress(api, { ...guarded, guard_session: 'first-play' });
    api.getProgress.mockResolvedValue(null);
    await expect(saveProgress(api, { ...guarded, guard_session: 'next-play' })).resolves.toBe(
      'saved',
    );
    expect(api.getProgress).toHaveBeenCalledTimes(2);
  });

  it.each(['held', 'clear'] as const)(
    'drops a %s guard answer after sign-out, even for a strict rollback transfer',
    async (answer) => {
      const requested = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Progress | null>();
      const api = serverWith(() => {
        requested.resolve();
        return response.promise;
      });
      setConnectionAliases({ legacy: 'c1' });
      try {
        const saving = saveProgress(
          api,
          { ...guarded, connectionId: 'legacy' },
          { requireQueued: true },
        );
        await requested.promise;
        await removalCleanup('c1');
        const next = serverWith(null);
        routeClients({ legacy: next, c1: next });
        response.resolve(answer === 'held' ? ahead : null);
        await expect(saving).resolves.toBe('dropped');
        expect(await readQueue()).toEqual([]);
        expect(await readMirrorOf('legacy', 1, 'A/Book')).toBeNull();
        expect(held).toEqual([]);
        expect(next.saveProgress).not.toHaveBeenCalled();
        expect(api.saveProgress).not.toHaveBeenCalled();
      } finally {
        setConnectionAliases({});
      }
    },
  );

  it.each(['success', 'failure'] as const)(
    "a late PUT %s cannot change the next sign-in's queue",
    async (answer) => {
      const requested = Promise.withResolvers<void>();
      const response = Promise.withResolvers<void>();
      const api = fakeApi(() => {
        requested.resolve();
        return response.promise;
      });
      const saving = saveProgress(api, save);
      await requested.promise;
      await removalCleanup('c1');
      // The new account's clock was set back, so the old capture would replace or retire
      // this one if the queue update were based on timestamps alone.
      const next = { ...save, position: 95, updated_at: '2025-12-31T23:59:00Z' };
      reachable.mockReturnValue(false);
      await expect(saveProgress(api, next)).resolves.toBe('queued');
      if (answer === 'success') response.resolve();
      else response.reject(new Error('unreachable'));
      await expect(saving).resolves.toBe('dropped');
      expect(await readQueue()).toEqual([next]);
      expect(reachability.noteFailure).not.toHaveBeenCalled();
    },
  );

  it('an explicit live save retires an older held capture before replay', async () => {
    const api = serverWith(ahead);
    routeClients({ c1: api });
    await expect(saveProgress(api, guarded)).resolves.toBe('held');
    const chosen = { ...save, updated_at: '2026-01-01T00:01:00Z' };
    await expect(saveProgress(api, chosen)).resolves.toBe('saved');
    await flushConnection('c1', { lastChance: true });
    expect(api.saveProgress).toHaveBeenCalledTimes(1);
    expect(await readQueue()).toEqual([]);
  });

  it('a rollback that cannot store a held save knows to keep its events', async () => {
    const storage = AsyncStorage.setItem as jest.Mock;
    const write = storage.getMockImplementation()!;
    storage.mockImplementation((key: string, value: string) => {
      if (key === QUEUE_KEY) throw new Error('storage full');
      return write(key, value);
    });
    try {
      await expect(
        saveProgress(serverWith(ahead), guarded, { requireQueued: true }),
      ).rejects.toThrow('storage full');
      expect(await readQueue()).toEqual([]);
    } finally {
      storage.mockImplementation(write);
    }
  });

  it('an unguarded save (its start was known) is PUT without a read, as before', async () => {
    const api = serverWith(ahead);
    await expect(saveProgress(api, { ...save, position: 4.78 })).resolves.toBe('saved');
    expect(api.getProgress).not.toHaveBeenCalled();
    expect(api.saveProgress).toHaveBeenCalled();
  });

  it('offline, a guarded save is queued with its guard', async () => {
    reachable.mockReturnValue(false);
    const api = serverWith(ahead);
    await expect(saveProgress(api, guarded)).resolves.toBe('queued');
    expect(api.getProgress).not.toHaveBeenCalled();
    expect(await readQueue()).toEqual([expect.objectContaining({ guard: true })]);
  });

  it('a read that gets no answer queues the guarded save; nothing is PUT', async () => {
    const api = serverWith(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(saveProgress(api, guarded)).resolves.toBe('queued');
    expect(api.saveProgress).not.toHaveBeenCalled();
    expect(await readQueue()).toEqual([expect.objectContaining({ guard: true })]);
  });

  describe('a replay (the queue)', () => {
    it('keeps an unknown-start save queued and offers the further place', async () => {
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([guarded]));
      const api = serverWith(ahead);
      routeClients({ c1: api });
      await flushQueue();
      expect(api.saveProgress).not.toHaveBeenCalled();
      expect(await readQueue()).toEqual([guarded]);
      expect(held).toEqual([[guarded, ahead]]);
    });

    it("drops a held capture at the sign-out's last flush, never PUT unguarded", async () => {
      const api = serverWith(ahead);
      routeClients({ c1: api });
      const newer = { ...guarded, updated_at: '2026-01-01T00:03:00Z', position: 44 };
      await saveProgress(api, newer);
      // An older capture reaches the queue late. The latest one is kept.
      await saveProgress(api, guarded);
      await flushConnection('c1');
      expect(api.saveProgress).not.toHaveBeenCalled();
      expect(await readQueue()).toEqual([newer]);
      // Unanswered at sign-out: the legacy PUT would move the other device's further place
      // back (last-write-wins by updated_at), so it goes nowhere.
      api.getProgress.mockClear();
      await flushConnection('c1', { lastChance: true });
      expect(api.getProgress).toHaveBeenCalledTimes(1);
      expect(api.saveProgress).not.toHaveBeenCalled();
      expect(await readQueue()).toEqual([]);
      await removalCleanup('c1');
      expect(await readMirrorOf('c1', 1, 'A/Book')).toBeNull();
      // Nor does it reach whoever signs in next under that connection id.
      const next = serverWith(null);
      routeClients({ c1: next });
      await flushQueue();
      expect(next.saveProgress).not.toHaveBeenCalled();
    });

    it("sends a queued guarded capture at the last flush once the server's row lets it", async () => {
      let row: Progress = ahead;
      const api = serverWith(async () => row);
      routeClients({ c1: api });
      await saveProgress(api, guarded);
      expect(await readQueue()).toEqual([guarded]);
      // The other device's place is no further on any more (it moved back, or was reset).
      row = { ...ahead, position: 2 };
      await flushConnection('c1', { lastChance: true });
      expect(api.saveProgress).toHaveBeenCalledTimes(1);
      expect(api.saveProgress).toHaveBeenCalledWith(
        1,
        'A/Book',
        expect.objectContaining({ position: guarded.position, updated_at: guarded.updated_at }),
      );
      expect(await readQueue()).toEqual([]);
    });

    it('reads the row afresh at the last flush, not a hold read before the other device went back', async () => {
      const session = { ...guarded, guard_session: 'offer-unanswered' };
      let row: Progress = ahead;
      const api = serverWith(async () => row);
      routeClients({ c1: api });
      const now = jest.spyOn(Date, 'now');
      const start = Date.now();
      try {
        now.mockReturnValue(start);
        await expect(saveProgress(api, session)).resolves.toBe('held');
        // Under a minute later (the hold is still reused by a tick) the other device has gone
        // back below this capture, and the listener signs out.
        row = { ...ahead, position: 2 };
        now.mockReturnValue(start + 55_000);
        api.getProgress.mockClear();
        await flushConnection('c1', { lastChance: true });
        expect(api.getProgress).toHaveBeenCalledTimes(1);
        expect(api.saveProgress).toHaveBeenCalledTimes(1);
        expect(api.saveProgress).toHaveBeenCalledWith(
          1,
          'A/Book',
          expect.objectContaining({ position: session.position, updated_at: session.updated_at }),
        );
        expect(await readQueue()).toEqual([]);
      } finally {
        now.mockRestore();
      }
    });

    it("reuses a hold read moments ago at the last flush (the stop's own save): one read", async () => {
      const session = { ...guarded, guard_session: 'stopped-just-now' };
      const api = serverWith(ahead);
      routeClients({ c1: api });
      await expect(saveProgress(api, session)).resolves.toBe('held');
      await flushConnection('c1', { lastChance: true });
      expect(api.getProgress).toHaveBeenCalledTimes(1);
      expect(api.saveProgress).not.toHaveBeenCalled();
      expect(await readQueue()).toEqual([]);
    });

    it('keeps a held capture whose guard read gets no answer at the last flush, unsent', async () => {
      let fail = false;
      const api = serverWith(async () => {
        if (fail) throw new TypeError('Failed to fetch');
        return ahead;
      });
      routeClients({ c1: api });
      await saveProgress(api, guarded);
      fail = true;
      await flushConnection('c1', { lastChance: true });
      expect(api.saveProgress).not.toHaveBeenCalled();
      // Left for the purge (an unreachable server's unsynced saves go with the sign-in).
      expect(await readQueue()).toEqual([guarded]);
      await removalCleanup('c1');
      expect(await readQueue()).toEqual([]);
    });

    it('a known-start save still replays (no guard, no read)', async () => {
      const known = { ...save, position: 4.78 };
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([known]));
      const api = serverWith(ahead);
      routeClients({ c1: api });
      await flushQueue();
      expect(api.getProgress).not.toHaveBeenCalled();
      expect(api.saveProgress).toHaveBeenCalledWith(
        1,
        'A/Book',
        expect.objectContaining({ position: 4.78 }),
      );
      expect(await readQueue()).toEqual([]);
    });

    it('a guarded save the server has nothing further for replays', async () => {
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([guarded]));
      const api = serverWith(null);
      routeClients({ c1: api });
      await flushConnection('c1');
      expect(api.saveProgress).toHaveBeenCalledTimes(1);
      expect(await readQueue()).toEqual([]);
    });

    it("a replayed guarded save settles its session's guard; a held one does not", async () => {
      await AsyncStorage.setItem(
        QUEUE_KEY,
        JSON.stringify([{ ...guarded, guard_session: 's-replayed' }]),
      );
      routeClients({ c1: serverWith(null) });
      await flushConnection('c1');
      expect(guardSettled('s-replayed')).toBe(true);

      await AsyncStorage.setItem(
        QUEUE_KEY,
        JSON.stringify([{ ...guarded, guard_session: 's-held' }]),
      );
      routeClients({ c1: serverWith(ahead) });
      await flushConnection('c1');
      expect(guardSettled('s-held')).toBe(false);
    });

    it('a live guarded save that goes through settles its session too', async () => {
      await expect(
        saveProgress(serverWith(null), { ...guarded, guard_session: 's-live' }),
      ).resolves.toBe('saved');
      expect(guardSettled('s-live')).toBe(true);
    });

    // fe#259: the settled sessions were never pruned; only the newest 50 are kept.
    it('keeps the newest settled sessions only', async () => {
      const api = serverWith(null);
      for (let i = 0; i < 51; i++) {
        await saveProgress(api, { ...guarded, guard_session: `s-many-${i}` });
      }
      expect(guardSettled('s-many-0')).toBe(false);
      expect(guardSettled('s-many-1')).toBe(true);
      expect(guardSettled('s-many-50')).toBe(true);
    });

    it('a read with no answer keeps the guarded save queued for later', async () => {
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([guarded]));
      const api = serverWith(() => Promise.reject(new TypeError('Failed to fetch')));
      routeClients({ c1: api });
      await flushConnection('c1');
      expect(api.saveProgress).not.toHaveBeenCalled();
      expect(await readQueue()).toEqual([expect.objectContaining({ guard: true })]);
    });
  });

  describe('resumeLookupOf says when a place was not checked', () => {
    const places = async () => readLocalPlaces();
    const mine = { ...save, position: 120, updated_at: '2026-01-02T00:00:00Z' };

    it('not when it resumes from the server row, or the server had nothing', async () => {
      await writeMirror(mine);
      const newer = makeProgress({ position: 3570, updated_at: '2026-01-03T00:00:00Z' });
      expect(resumeLookupOf(newer, await places(), 'c1', 1, 'A/Book')).not.toHaveProperty(
        'unchecked',
      );
      expect(resumeLookupOf(null, await places(), 'c1', 1, 'A/Book')).not.toHaveProperty(
        'unchecked',
      );
    });

    it('when the server was not reached', async () => {
      await writeMirror(mine);
      expect(resumeLookupOf(undefined, await places(), 'c1', 1, 'A/Book')).toMatchObject({
        unchecked: true,
      });
    });

    it("when this device's newer record resumes behind the server's further place", async () => {
      await writeMirror(mine);
      expect(resumeLookupOf(ahead, await places(), 'c1', 1, 'A/Book')).toMatchObject({
        progress: { position: 120 },
        unchecked: true,
      });
      // Not for a finished row, or one within 30 s.
      expect(
        resumeLookupOf({ ...ahead, finished: true }, await places(), 'c1', 1, 'A/Book'),
      ).not.toHaveProperty('unchecked');
      expect(
        resumeLookupOf({ ...ahead, position: 140 }, await places(), 'c1', 1, 'A/Book'),
      ).not.toHaveProperty('unchecked');
    });
  });
});

// The web player's tabs share one legacy queue. A lock per tab let one tab's replay write
// its read of the queue over a save another tab queued meanwhile; a lock across tabs held
// over the replay's requests outlived a plain-http lease (5 s). A replay now claims what it
// sends under the lock, sends with no lock held, and settles under it again.
describe('the legacy queue across tabs', () => {
  const nav = globalThis.navigator as { locks?: unknown };

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    reachable.mockReset().mockReturnValue(true);
    mockResolveClient.mockReset().mockReturnValue(null);
    mockSessionReady.mockReset().mockReturnValue(true);
    // One browser's Web Locks: a job per name at a time, whichever tab asks.
    const chains = new Map<string, Promise<unknown>>();
    const request = (name: string, job: () => Promise<unknown>) => {
      const run = (chains.get(name) ?? Promise.resolve()).then(job);
      chains.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    };
    Object.defineProperty(nav, 'locks', { configurable: true, value: { request } });
  });
  afterEach(() => {
    delete nav.locks;
  });

  /** Another tab: its own copy of the module over the same storage and the same seams. */
  const otherTab = () => {
    let other!: typeof import('@/playback/progress-sync');
    jest.isolateModules(() => {
      jest.doMock('@react-native-async-storage/async-storage', () => ({
        __esModule: true,
        default: AsyncStorage,
      }));
      jest.doMock('@/api/connection-clients', () => ({
        resolveClient: mockResolveClient,
        sessionReady: mockSessionReady,
      }));
      jest.doMock('@/api/reachability', () => reachability);
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      other = require('@/playback/progress-sync') as typeof import('@/playback/progress-sync');
    });
    return other;
  };

  /** A PUT that waits until `answer` is called. */
  function slowApi() {
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const api = {
      saveProgress: jest.fn(() => answered),
      getProgress: jest.fn(async () => null),
    } as unknown as ApiClient;
    return { api, answer: () => answer() };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const queued = { ...save, path: 'B/Other', updated_at: '2026-01-02T00:00:00Z' };

  it("keeps a save another tab queued while this tab's replay was out", async () => {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([save]));
    const { api, answer } = slowApi();
    routeClients({ c1: api });
    const flushing = flushQueue();
    await tick();
    expect(api.saveProgress).toHaveBeenCalledTimes(1);
    // Tab B goes offline mid-replay and queues its own save; the lock is free for it.
    reachable.mockReturnValue(false);
    await expect(
      otherTab().saveProgress(
        fakeApi(async () => {}),
        queued,
      ),
    ).resolves.toBe('queued');
    answer();
    await flushing;
    expect(await readQueue()).toEqual([queued]);
  });

  it("does not send a save another tab's replay is sending; one that failed there is sent later", async () => {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([save]));
    const { api } = slowApi();
    let refuse!: () => void;
    (api.saveProgress as jest.Mock).mockImplementation(
      () => new Promise((_, reject) => (refuse = () => reject(new TypeError('Failed to fetch')))),
    );
    routeClients({ c1: api });
    const flushing = flushQueue();
    await tick();
    const other = otherTab();
    await other.flushQueue();
    expect(api.saveProgress).toHaveBeenCalledTimes(1);
    // The replay out fails: the save stays queued, unclaimed, and the next replay sends it.
    refuse();
    await flushing;
    expect(await readQueue()).toEqual([save]);
    (api.saveProgress as jest.Mock).mockImplementation(async () => {});
    await other.flushQueue();
    expect(api.saveProgress).toHaveBeenCalledTimes(2);
    expect(await readQueue()).toEqual([]);
  });

  it('replays the saves of a tab that went away with them claimed, once its claim ran out', async () => {
    const claim = { id: 'gone', until: Date.now() + 60_000 };
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([{ ...save, claim }]));
    const api = fakeApi(async () => {});
    routeClients({ c1: api });
    await flushQueue();
    expect(api.saveProgress).not.toHaveBeenCalled();
    await AsyncStorage.setItem(
      QUEUE_KEY,
      JSON.stringify([{ ...save, claim: { ...claim, until: Date.now() - 1 } }]),
    );
    await flushQueue();
    expect(api.saveProgress).toHaveBeenCalledTimes(1);
    expect(await readQueue()).toEqual([]);
  });

  // Storage full: a replay whose claim is not in the queue would send what another tab's
  // replay sends too.
  it('sends nothing while storage refuses its claim, and replays once it can write', async () => {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([save]));
    const api = fakeApi(async () => {});
    routeClients({ c1: api });
    const setItem = AsyncStorage.setItem as jest.Mock;
    const write = setItem.getMockImplementation()!;
    setItem.mockImplementation(async (key: string, value: string) => {
      if (key === QUEUE_KEY) throw new Error('quota');
      return write(key, value);
    });
    try {
      await flushQueue();
    } finally {
      setItem.mockImplementation(write);
    }
    expect(api.saveProgress).not.toHaveBeenCalled();
    expect(await readQueue()).toEqual([save]);
    await flushQueue();
    expect(api.saveProgress).toHaveBeenCalledTimes(1);
    expect(await readQueue()).toEqual([]);
  });

  it('a save queued again while its older copy is out leaves the newer one queued', async () => {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([save]));
    const { api, answer } = slowApi();
    routeClients({ c1: api });
    const flushing = flushConnection('c1');
    await tick();
    reachable.mockReturnValue(false);
    const newer = { ...save, position: 40, updated_at: '2026-01-03T00:00:00Z' };
    await saveProgress(api, newer);
    answer();
    await flushing;
    expect(await readQueue()).toEqual([newer]);
  });

  // This tab's timers throttled past its claim, or a sign-out's last send in another tab: the
  // second save is that replay's to send, and here it went twice.
  it('does not send a save another replay claimed while the one ahead of it was out', async () => {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([save, queued]));
    const { api, answer } = slowApi();
    routeClients({ c1: api });
    const flushing = flushQueue();
    await tick();
    expect(api.saveProgress).toHaveBeenCalledTimes(1);
    const other = { id: 'other', until: Date.now() + 60_000 };
    await AsyncStorage.setItem(
      QUEUE_KEY,
      JSON.stringify(
        (await readQueue()).map((s) => (s.path === queued.path ? { ...s, claim: other } : s)),
      ),
    );
    answer();
    await flushing;
    expect(api.saveProgress).toHaveBeenCalledTimes(1);
    expect(await readQueue()).toEqual([{ ...queued, claim: other }]);
  });

  // Signed out here, a save another tab's replay had claimed was left to it and purged unsent.
  describe("a sign-out's last-chance flush and another tab's claim", () => {
    const claimed = { ...save, claim: { id: 'other', until: Date.now() + 60_000 } };
    let os: typeof Platform.OS;
    beforeEach(async () => {
      os = Platform.OS;
      claimed.claim.until = Date.now() + 60_000;
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([claimed]));
    });
    afterEach(() => {
      Platform.OS = os;
    });

    it('takes the claim over on the web; a reconnect leaves it', async () => {
      Platform.OS = 'web';
      const api = fakeApi(async () => {});
      routeClients({ c1: api });
      await flushConnection('c1');
      expect(api.saveProgress).not.toHaveBeenCalled();
      await flushConnection('c1', { lastChance: true });
      expect(api.saveProgress).toHaveBeenCalledTimes(1);
      expect(await readQueue()).toEqual([]);
    });

    // Off the web the app is one process: a claim no replay of this launch is sending was
    // left by a run killed mid-replay, and kept, the save went with the purge unsent.
    it('sends off the web one an earlier launch left claimed; a reconnect leaves it', async () => {
      const api = fakeApi(async () => {});
      routeClients({ c1: api });
      await flushConnection('c1');
      expect(api.saveProgress).not.toHaveBeenCalled();
      await flushConnection('c1', { lastChance: true });
      expect(api.saveProgress).toHaveBeenCalledTimes(1);
      expect(await readQueue()).toEqual([]);
    });
  });

  // Off the web, a claim left by a replay of this launch that ended (its settle not stored) is
  // free to the last send: kept for its time, the purge took the save unsent.
  it("sends off the web a save this launch's replay left claimed when storage refused its settle", async () => {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([save]));
    const sendSave = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(undefined);
    const api = fakeApi(sendSave);
    routeClients({ c1: api });
    const setItem = AsyncStorage.setItem as jest.Mock;
    const write = setItem.getMockImplementation()!;
    // The claim's write goes through, the settle's (taking the claim off) is refused.
    let queueWrites = 0;
    setItem.mockImplementation(async (key: string, value: string) => {
      if (key === QUEUE_KEY && ++queueWrites === 2) throw new Error('quota');
      return write(key, value);
    });
    try {
      await flushConnection('c1');
    } finally {
      setItem.mockImplementation(write);
    }
    expect(queueWrites).toBe(2);
    expect(api.saveProgress).toHaveBeenCalledTimes(1);
    expect((await readQueue())[0]).toMatchObject({ path: save.path, claim: expect.anything() });
    // Signed out at once, the claim still standing by its time.
    await flushConnection('c1', { lastChance: true });
    expect(api.saveProgress).toHaveBeenCalledTimes(2);
    expect(await readQueue()).toEqual([]);
    await removalCleanup('c1');
    expect(await readQueue()).toEqual([]);
  });

  it("a sign-out's last-chance flush waits for this tab's replay that is out", async () => {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([save]));
    const { api, answer } = slowApi();
    routeClients({ c1: api });
    const flushing = flushQueue();
    await tick();
    let lastChanceDone = false;
    const lastChance = flushConnection('c1').then(() => (lastChanceDone = true));
    await tick();
    // Resolved now, the token would be revoked under the save still on its way.
    expect(lastChanceDone).toBe(false);
    answer();
    await Promise.all([flushing, lastChance]);
    expect(api.saveProgress).toHaveBeenCalledTimes(1);
    expect(await readQueue()).toEqual([]);
  });

  // The check before the second save could not read the queue (`getItem` gave it as empty):
  // kept, it had no later replay, and the connection's purge took it unsent. Off the web too.
  describe('storage the check before a send cannot read', () => {
    /** A replay with the first save out, the next read of the queue failing once. */
    async function unreadableAtCheck(replay: () => Promise<void>) {
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([save, queued]));
      const { api, answer } = slowApi();
      routeClients({ c1: api });
      const flushing = replay();
      await tick();
      expect(api.saveProgress).toHaveBeenCalledTimes(1);
      const getItem = AsyncStorage.getItem as jest.Mock;
      const read = getItem.getMockImplementation()!;
      let failed = false;
      getItem.mockImplementation(async (key: string) => {
        if (key === QUEUE_KEY && !failed) {
          failed = true;
          throw new Error('unreadable');
        }
        return read(key);
      });
      try {
        answer();
        await flushing;
      } finally {
        getItem.mockImplementation(read);
      }
      expect(failed).toBe(true);
      return api;
    }

    it("a sign-out's last-chance flush sends the save", async () => {
      const api = await unreadableAtCheck(() => flushConnection('c1', { lastChance: true }));
      expect(api.saveProgress).toHaveBeenCalledTimes(2);
      expect(await readQueue()).toEqual([]);
    });

    it('a replay keeps it for the next one', async () => {
      const api = await unreadableAtCheck(() => flushQueue());
      expect(api.saveProgress).toHaveBeenCalledTimes(1);
      expect(await readQueue()).toEqual([queued]);
    });
  });
});

// fe#258's follow-up: the record a Mark as finished replaced rides on the finished record, so
// the Undo of a finish that never left decides by the record it changes, under the mirror's
// lock, in any tab and after a reload.
describe('the place before a finish (writeFinishedMirror)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  const place = { ...save, position: 48, updated_at: '2026-01-01T00:00:00Z' };
  const finish = { ...save, position: 100, finished: true, updated_at: '2026-01-02T00:00:00Z' };

  it('carries the place it replaced; a later record does not keep it', async () => {
    await writeMirror(place);
    await writeFinishedMirror(finish);
    expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({
      finished: true,
      before: { position: 48, finished: false, updated_at: place.updated_at },
    });
    // The server's row for the finish read back: not this device's Mark, so the record no
    // longer carries the place (carried on, an old finish's place would stand for every
    // later one). The Undo in the tab that marked it keeps that place itself, outside the
    // mirror (`placeBefore` in the store), so it still goes back to the file place.
    await writeMirror({ ...finish, updated_at: '2026-01-02T00:00:01Z', server_clock: true });
    expect(await readMirrorOf('c1', 1, 'A/Book')).not.toHaveProperty('before');
  });

  it('the same finish written again keeps its place; none over no place', async () => {
    await writeMirror(place);
    await writeFinishedMirror(finish);
    await writeFinishedMirror({ ...finish, playback_speed: 1.5 });
    expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({
      playback_speed: 1.5,
      before: { position: 48 },
    });
    await writeFinishedMirror({ ...finish, path: 'B/Other' });
    expect(await readMirrorOf('c1', 1, 'B/Other')).not.toHaveProperty('before');
  });

  // Carried on, the Undo of the second finish went back to the place before the first: the
  // book unfinished at a place older than the finish it undid.
  it('another finish over a finished record carries no place', async () => {
    await writeMirror(place);
    await writeFinishedMirror(finish);
    await writeFinishedMirror({ ...finish, updated_at: '2026-01-03T00:00:00Z' });
    const record = await readMirrorOf('c1', 1, 'A/Book');
    expect(record).toMatchObject({ finished: true, updated_at: '2026-01-03T00:00:00Z' });
    expect(record).not.toHaveProperty('before');
    // Another device's finish with this one's stamp is not this finish either.
    const third = { path: 'C/Third' };
    await writeMirror({ ...place, ...third });
    await writeFinishedMirror({ ...finish, ...third });
    expect((await readMirrorOf('c1', 1, 'C/Third'))?.before).toMatchObject({ position: 48 });
    await writeFinishedMirror({ ...finish, ...third, device_id: 'other' });
    expect(await readMirrorOf('c1', 1, 'C/Third')).not.toHaveProperty('before');
  });
});

// On plain http the mirror's lock is a lease that costs each job a wait (30 ms or more): the
// writes asked while one waits share its read and write.
describe('mirror writes asked together', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  const mirrorWrites = () =>
    (AsyncStorage.setItem as jest.Mock).mock.calls.filter(([key]) => key === MIRROR_KEY).length;

  it('are written once', async () => {
    const before = mirrorWrites();
    await Promise.all(
      ['A', 'B', 'C', 'D', 'E'].map((p) => writeMirror({ ...save, path: `${p}/Book` })),
    );
    expect(mirrorWrites() - before).toBe(1);
    expect(Object.keys(await readMirror())).toHaveLength(5);
  });

  it('never ahead of a change of the mirror asked before them', async () => {
    const first = writeMirror(save);
    const removed = updateMirror('c1', 1, 'A/Book', () => null);
    const again = writeMirror({ ...save, position: 20, updated_at: '2026-01-02T00:00:00Z' });
    await Promise.all([first, removed, again]);
    expect(await readMirrorOf('c1', 1, 'A/Book')).toMatchObject({ position: 20 });
  });
});

// fe#258's follow-up: after an Undo in one tab, another tab kept showing the book finished
// ("Listen again") until clicked. The undoing tab tells the others on a tab channel.
describe('a finish undone in another tab', () => {
  afterEach(() => setUndoneChannelForTests(undefined));

  it('is posted on the channel and heard by its subscribers', () => {
    const listeners = new Set<(ref: unknown) => void>();
    const posted: unknown[] = [];
    setUndoneChannelForTests({
      post: (message) => {
        posted.push(message);
        for (const l of listeners) l(message);
      },
      subscribe: (listener) => {
        listeners.add(listener as (ref: unknown) => void);
        return () => listeners.delete(listener as (ref: unknown) => void);
      },
    });
    const told: unknown[] = [];
    const stop = onFinishUndoneElsewhere((ref) => told.push(ref));
    const ref = { connectionId: 'c1', libraryId: 4, path: 'Author/Book: Two' };
    tellUndoneElsewhere({ ...ref, position: 12 } as typeof ref);
    // Only the book goes out.
    expect(posted).toEqual([ref]);
    expect(told).toEqual([ref]);
    stop();
    tellUndoneElsewhere(ref);
    expect(told).toHaveLength(1);
  });

  it('is nothing without a channel (off the web)', () => {
    setUndoneChannelForTests(null);
    expect(() =>
      tellUndoneElsewhere({ connectionId: 'c1', libraryId: 1, path: 'A' }),
    ).not.toThrow();
    expect(typeof onFinishUndoneElsewhere(() => {})).toBe('function');
  });
});

describe('which connections a replay of the legacy queue sends', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    for (const id of ['c1', 'c2']) forgetRateLimit(id);
    jest.clearAllMocks();
    reachable.mockReset().mockReturnValue(true);
    mockResolveClient.mockReset().mockReturnValue(null);
    mockSessionReady.mockReset().mockReturnValue(true);
  });

  // The session of a web tab holds the connections it loaded: one signed in to in another tab
  // since is stored, not in it, and this tab's replay dropped its saves as gone.
  describe('on the web', () => {
    let os: typeof Platform.OS;
    beforeEach(() => {
      os = Platform.OS;
      Platform.OS = 'web';
    });
    afterEach(() => {
      Platform.OS = os;
    });

    it('leaves the saves of a connection another tab is signed in to', async () => {
      await AsyncStorage.setItem(CONNECTIONS_KEY, JSON.stringify([{ id: 'c1' }]));
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([save]));
      await flushQueue();
      expect(await readQueue()).toEqual([save]);
    });

    it('keeps them when the stored connections cannot be read', async () => {
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([save]));
      const getItem = AsyncStorage.getItem as jest.Mock;
      const read = getItem.getMockImplementation()!;
      getItem.mockImplementation(async (key: string) => {
        if (key === CONNECTIONS_KEY) throw new Error('unreadable');
        return read(key);
      });
      try {
        await flushQueue();
      } finally {
        getItem.mockImplementation(read);
      }
      expect(await readQueue()).toEqual([save]);
    });

    it('drops them once no tab is signed in to it', async () => {
      await AsyncStorage.setItem(CONNECTIONS_KEY, JSON.stringify([{ id: 'c2' }]));
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([save]));
      await flushQueue();
      expect(await readQueue()).toEqual([]);
    });
  });

  it('drops a connection the app does not know off the web, though it is stored', async () => {
    await AsyncStorage.setItem(CONNECTIONS_KEY, JSON.stringify([{ id: 'c1' }]));
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([save]));
    await flushQueue();
    expect(await readQueue()).toEqual([]);
  });

  // A queued save can still name the id the identity migration moved its connection from.
  describe('a save naming the id its connection moved from', () => {
    const moved = { ...save, connectionId: 'legacy' };
    beforeEach(() => setConnectionAliases({ legacy: 'c1' }));
    afterEach(() => setConnectionAliases({}));

    it('is the connection’s own to a route of that connection alone', () => {
      const route = routeOnly('c1', (cid) => cid);
      expect(route('c1')).toBe('c1');
      expect(route('legacy')).toBe('legacy');
      expect(route('c2')).toBe('keep');
      expect(routeOnly('legacy', (cid) => cid)('c1')).toBe('c1');
    });

    // Left by the sign-out's last flush, the purge kept it (it names another id) and the
    // next replay dropped it unsent, its connection gone.
    it('goes with a flush of its connection', async () => {
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([moved]));
      const api = fakeApi(async () => {});
      routeClients({ c1: api, legacy: api });
      await flushConnection('c1', { lastChance: true });
      expect(api.saveProgress).toHaveBeenCalledTimes(1);
      expect(await readQueue()).toEqual([]);
    });

    // Counted at sign-out and tried by its last send, but the purge matched the id alone:
    // one its last send could not land stayed queued under a connection that was gone.
    it('is counted and purged with its connection', async () => {
      const other = { ...save, connectionId: 'c2', path: 'B/Other' };
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([moved, other]));
      expect((await pendingSaves('c1')).saves).toBe(1);
      await removalCleanup('c1');
      expect(await readQueue()).toEqual([other]);
    });

    it('on the web, is kept while another tab is signed in to the connection', async () => {
      const os = Platform.OS;
      Platform.OS = 'web';
      try {
        await AsyncStorage.setItem(CONNECTIONS_KEY, JSON.stringify([{ id: 'c1' }]));
        await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([moved]));
        await flushQueue();
        expect(await readQueue()).toEqual([moved]);
        await AsyncStorage.setItem(CONNECTIONS_KEY, JSON.stringify([]));
        await flushQueue();
        expect(await readQueue()).toEqual([]);
      } finally {
        Platform.OS = os;
      }
    });
  });

  // A proxy turning the device away (fe#295) holds the saves; the server's own answer ends
  // the episode, and that connection's saves go then, not at the next replay.
  it('replays only the connection whose proxy refusals ended', async () => {
    const refusing = fakeApi(() =>
      Promise.reject(new ApiError(403, 'Forbidden', undefined, undefined, true)),
    );
    await expect(saveProgress(refusing, save)).resolves.toBe('queued');
    const other = { ...save, connectionId: 'c2', path: 'B/Other' };
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([...(await readQueue()), other]));
    const one = fakeApi(async () => {});
    const two = fakeApi(async () => {});
    routeClients({ c1: one, c2: two });
    proxyRefusalsOver('c1');
    for (let i = 0; i < 60 && (await readQueue()).length > 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(one.saveProgress).toHaveBeenCalledTimes(1);
    expect(two.saveProgress).not.toHaveBeenCalled();
    expect(await readQueue()).toEqual([other]);
  });

  // Every connection's queue went at a hold's end, not only the one it held.
  it('replays only the connection whose 429 wait is over', async () => {
    const limited = fakeApi(() => Promise.reject(new ApiError(429, 'slow down', undefined, 1)));
    await expect(saveProgress(limited, save)).resolves.toBe('queued');
    const other = { ...save, connectionId: 'c2', path: 'B/Other' };
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([...(await readQueue()), other]));
    const one = fakeApi(async () => {});
    const two = fakeApi(async () => {});
    routeClients({ c1: one, c2: two });
    for (let i = 0; i < 60 && (await readQueue()).length > 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(one.saveProgress).toHaveBeenCalledTimes(1);
    expect(two.saveProgress).not.toHaveBeenCalled();
    expect(await readQueue()).toEqual([other]);
  });
});
