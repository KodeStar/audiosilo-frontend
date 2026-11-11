import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiClient, ApiError } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import * as reachability from '@/api/reachability';
import type { Progress } from '@/api/types';
import { onConnectionRemoved } from '@/stores/session';

import {
  ackVersion,
  flushConnection,
  guardHolds,
  guardSettled,
  onHeldSave,
  flushQueue,
  loadInitialProgress,
  answerOffer,
  ignoreOffer,
  bookPlace,
  positionOn,
  withLocalPlaces,
  noteClockSkew,
  pendingSaveCount,
  type PlacedProgress,
  type ProgressSave,
  readLocalPlaces,
  readMirror as readMirrorOf,
  resumeLookupOf,
  saveProgress,
  serverRowOf,
  writeMirror,
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

describe('the file place (fe#188) and the Sync v2 mirror fields', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

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

  // fe#208: the echo is stamped in server time, the capture in this device's time.
  describe("a device whose clock is behind the server's", () => {
    // The stored skews come from the outbox, their one reader (fe#211): a stand-in here.
    let stored: Record<string, number> = {};
    beforeAll(() => provideStoredSkews(async () => stored));
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
      await writeMirror({ ...save, position: 4100, updated_at: '2026-01-02T00:00:22Z' });
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
      answered: ['watch|a'],
    });
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
    expect(await readQueue()).toEqual([]);
    const mirrored = await readMirrorOf('c1', 1, 'A/Book');
    expect(mirrored).toMatchObject({ position: 4.78 });
    expect(mirrored).not.toHaveProperty('guard'); // never kept in the mirror
  });

  it('a listener that throws leaves the save held, not queued as a failure', async () => {
    const stop = onHeldSave(() => {
      throw new Error('listener broke');
    });
    try {
      const api = serverWith(ahead);
      await expect(saveProgress(api, guarded)).resolves.toBe('held');
      expect(await readQueue()).toEqual([]);
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
    it('an unknown-start save against a far-ahead server: no PUT, it leaves the queue, the place is offered', async () => {
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([guarded]));
      const api = serverWith(ahead);
      routeClients({ c1: api });
      await flushQueue();
      expect(api.saveProgress).not.toHaveBeenCalled();
      expect(await readQueue()).toEqual([]);
      expect(held).toEqual([[guarded, ahead]]);
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
