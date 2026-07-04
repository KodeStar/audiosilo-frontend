import { ApiError, type ApiClient } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import { isReachable, noteError, noteSuccess } from '@/api/reachability';
import type { Progress } from '@/api/types';
import { contentKey } from '@/lib/content-key';
import { getItem, setItem } from '@/lib/storage';
import { onConnectionRemoved } from '@/stores/session';

// Reconnect-driven replay is wired in `provider.tsx`: when a connection recovers it runs
// `flushConnection(cid)`, so a returning server replays exactly its own queued saves.

const QUEUE_KEY = 'audiosilo.progressQueue';
const DEVICE_KEY = 'audiosilo.deviceId';
// Durable, never-pruned mirror of the last-known progress per (connection, library,
// path). Unlike the offline queue (cleared once a save syncs), this survives sync so a
// returning listener can resume even when the server momentarily can't be reached - the
// fix for "an in-progress book restarted from 0 because the resume fetch failed".
const MIRROR_KEY = 'audiosilo.progressMirror';

let deviceIdCache: string | null = null;

/** Stable per-install device id, sent with progress for last-write-wins. */
export async function getDeviceId(): Promise<string> {
  if (deviceIdCache) return deviceIdCache;
  let id = await getItem<string>(DEVICE_KEY);
  if (!id) {
    id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await setItem(DEVICE_KEY, id);
  }
  deviceIdCache = id;
  return id;
}

export type ProgressSave = {
  /** Which server this save belongs to (never replay it against another). */
  connectionId: string;
  libraryId: number;
  path: string;
  position: number;
  duration: number;
  finished: boolean;
  playback_speed: number;
  device_id: string;
  /** Set at capture time so offline replays reconcile correctly by timestamp. */
  updated_at: string;
};

/**
 * The outcome of resolving where to resume a book. The three cases are deliberately
 * distinct so the player never confuses "the server says this book is brand new"
 * (start at 0 is correct) with "we couldn't reach the server" (must NOT assume 0):
 *  - `progress`: a saved position exists (from the server, the durable mirror, or the
 *    offline queue, reconciled by `updated_at`).
 *  - `empty`: the server answered (HTTP 200) and there is no record anywhere → new book.
 *  - `failed`: the server was unreachable AND there is no local record → unknown; the
 *    caller must fail safe rather than restart at 0.
 */
export type ResumeLookup =
  | { kind: 'progress'; progress: Progress }
  | { kind: 'empty' }
  | { kind: 'failed' };

/** Newest of two progress records by `updated_at` (last-write-wins, same rule the
 * server uses); ties keep the first argument. */
function timeOf(p: Progress): number {
  const t = Date.parse(p.updated_at);
  return Number.isNaN(t) ? 0 : t;
}
function newest(a: Progress | null, b: Progress | null): Progress | null {
  if (!a) return b;
  if (!b) return a;
  return timeOf(b) > timeOf(a) ? b : a;
}

/** The durable mirror map (keyed by `contentKey`). */
async function readMirrorMap(): Promise<Record<string, ProgressSave>> {
  return (await getItem<Record<string, ProgressSave>>(MIRROR_KEY)) ?? {};
}

/** The offline replay queue. */
async function readQueue(): Promise<ProgressSave[]> {
  return (await getItem<ProgressSave[]>(QUEUE_KEY)) ?? [];
}

export async function loadInitialProgress(
  api: ApiClient,
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<ResumeLookup> {
  let serverOk = false;
  let server: Progress | null = null;
  try {
    server = await api.getProgress(libraryId, path); // null = HTTP 200, no record (new book)
    serverOk = true;
  } catch (e) {
    // Reachability is per-connection, so note the failure against THIS book's own
    // server (it drives that connection's banner + probe). The local mirror/queue
    // fallback below keys off `serverOk`, not this call.
    noteError(connectionId, e);
  }
  // Cache the authoritative server value so a later offline resume has it (keep-newest,
  // so a locally-newer offline advance isn't regressed by a stale server read).
  if (serverOk && server) await writeMirror(progressToSave(connectionId, libraryId, path, server));

  const mirror = mirrorAsProgress(libraryId, path, await readMirror(connectionId, libraryId, path));
  const queued = await pendingProgressFor(connectionId, libraryId, path);
  const best = newest(newest(server, mirror), queued);

  if (best) return { kind: 'progress', progress: best };
  if (serverOk) return { kind: 'empty' }; // server reachable + nothing anywhere = truly new
  return { kind: 'failed' }; // never reached the server and no local fallback
}

function mirrorAsProgress(
  libraryId: number,
  path: string,
  save: ProgressSave | null,
): Progress | null {
  return save
    ? {
        library_id: libraryId,
        path,
        position: save.position,
        duration: save.duration,
        finished: save.finished,
        playback_speed: save.playback_speed,
        version: 0,
        device_id: save.device_id,
        updated_at: save.updated_at,
      }
    : null;
}

function progressToSave(
  connectionId: string,
  libraryId: number,
  path: string,
  p: Progress,
): ProgressSave {
  return {
    connectionId,
    libraryId,
    path,
    position: p.position,
    duration: p.duration,
    finished: p.finished,
    playback_speed: p.playback_speed,
    device_id: p.device_id,
    updated_at: p.updated_at,
  };
}

// Serialize mirror read-modify-write so concurrent saves can't clobber each other.
let mirrorLock: Promise<unknown> = Promise.resolve();
function withMirrorLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mirrorLock.then(fn, fn);
  mirrorLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Upsert the durable mirror, keeping the newest record by `updated_at`. */
export async function writeMirror(save: ProgressSave): Promise<void> {
  await withMirrorLock(async () => {
    const map = await readMirrorMap();
    const key = contentKey(save.connectionId, save.libraryId, save.path);
    const existing = map[key];
    if (!existing || Date.parse(save.updated_at) >= Date.parse(existing.updated_at)) {
      map[key] = save;
      await setItem(MIRROR_KEY, map);
    }
  });
}

export async function readMirror(
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<ProgressSave | null> {
  const map = await readMirrorMap();
  return map[contentKey(connectionId, libraryId, path)] ?? null;
}

/** Reconstruct progress from the offline replay queue, so a downloaded book
 * resumes at the right spot when the server can't be reached. */
async function pendingProgressFor(
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<Progress | null> {
  const queue = await readQueue();
  const save = queue.find(
    (s) => s.connectionId === connectionId && s.libraryId === libraryId && s.path === path,
  );
  if (!save) return null;
  return {
    library_id: libraryId,
    path,
    position: save.position,
    duration: save.duration,
    finished: save.finished,
    playback_speed: save.playback_speed,
    version: 0,
    device_id: save.device_id,
    updated_at: save.updated_at,
  };
}

function isUnrecoverable(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500;
}

/** Save progress now; if the network fails, queue it for later replay. version
 * is left 0 so the server reconciles by (updated_at, version). */
export async function saveProgress(api: ApiClient, save: ProgressSave): Promise<void> {
  // Reachability is per-connection: this save's success/failure notes ONLY its own
  // server. A book keeps playing on a connection the user has navigated away from, and
  // its 15s save loop lands here without touching any other server's state.
  // Always record the latest position in the durable mirror, independent of the network
  // outcome - this is what a future resume falls back to when the server can't be reached.
  await writeMirror(save);
  // This server known to be unreachable: queue locally without hitting the network, so
  // the 15s save loop doesn't fire a doomed request every tick while it's offline.
  if (!isReachable(save.connectionId)) {
    await enqueue(save);
    return;
  }
  try {
    await api.saveProgress(save.libraryId, save.path, {
      position: save.position,
      duration: save.duration,
      finished: save.finished,
      playback_speed: save.playback_speed,
      version: 0,
      device_id: save.device_id,
      updated_at: save.updated_at,
    });
    noteSuccess(save.connectionId);
    void flushQueue();
  } catch (e) {
    if (isUnrecoverable(e)) return; // auth/forbidden - don't retry forever
    noteError(save.connectionId, e); // a connection error flips this server offline
    await enqueue(save);
  }
}

// Serialize all read-modify-write access to the queue so a flush and a
// concurrent save (or two overlapping flushes) can't clobber each other's writes
// and drop queued saves (review finding F4).
let queueLock: Promise<unknown> = Promise.resolve();
function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueLock.then(fn, fn);
  queueLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function enqueue(save: ProgressSave): Promise<void> {
  await withQueueLock(async () => {
    const queue = await readQueue();
    // Keep only the latest pending save per (connection, library, path).
    const next = queue.filter(
      (s) =>
        !(
          s.connectionId === save.connectionId &&
          s.libraryId === save.libraryId &&
          s.path === save.path
        ),
    );
    next.push(save);
    await setItem(QUEUE_KEY, next);
  });
}

/**
 * Replay one connection's queued saves in order through its client. Returns the saves
 * that must stay queued (unflushed). Success/failure is noted against THIS connection's
 * own reachability (per-connection banner + probe).
 */
async function flushGroup(
  cid: string,
  client: ApiClient,
  saves: ProgressSave[],
): Promise<ProgressSave[]> {
  const remaining: ProgressSave[] = [];
  // Stop the group only when the server is UNREACHABLE (no point hammering the rest of
  // it); a per-save server error still lets the rest of the group through.
  let stop = false;
  for (const save of saves) {
    if (stop) {
      remaining.push(save);
      continue;
    }
    try {
      await client.saveProgress(save.libraryId, save.path, {
        position: save.position,
        duration: save.duration,
        finished: save.finished,
        playback_speed: save.playback_speed,
        version: 0,
        device_id: save.device_id,
        updated_at: save.updated_at,
      });
      noteSuccess(cid);
    } catch (e) {
      if (isUnrecoverable(e)) continue; // 4xx: drop, can't ever succeed
      noteError(cid, e);
      remaining.push(save); // keep it to retry next time
      // An `ApiError` means the server ANSWERED (even a 500), so the failure is specific
      // to this save - keep flushing the rest of the group past it rather than blocking
      // every later book behind one poison entry. A non-`ApiError` is a connection/
      // network failure: the server is unreachable, so stop and retry the group later.
      if (!(e instanceof ApiError)) stop = true;
    }
  }
  return remaining;
}

/**
 * Replay queued saves (call on reconnect / app open / after a successful save). Each
 * entry replays through ITS OWN connection's client, so a save captured on server B
 * can never be written to server A. Grouped by connection preserving order; the
 * groups run concurrently (they touch disjoint servers), so one dead/slow server
 * can't delay every other server's replay by its full timeout.
 */
export async function flushQueue(): Promise<void> {
  // Load-bearing guard: a flush racing session hydrate would resolve every entry's
  // client to null (the connection list is still empty) and drop the whole queue as
  // unroutable. Wait until the session is ready so entries route to a real client.
  if (!sessionReady()) return;
  await withQueueLock(async () => {
    const queue = await readQueue();
    if (queue.length === 0) return;

    // Group by connection, preserving order.
    const groups = new Map<string, ProgressSave[]>();
    for (const save of queue) {
      const g = groups.get(save.connectionId);
      if (g) g.push(save);
      else groups.set(save.connectionId, [save]);
    }

    const remainingByGroup = await Promise.all(
      [...groups].map(async ([cid, saves]) => {
        if (!isReachable(cid)) return saves; // this server known down; keep its saves queued
        const client = resolveClient(cid);
        if (!client) return []; // connection removed - unroutable, drop the whole group
        return flushGroup(cid, client, saves);
      }),
    );
    await setItem(QUEUE_KEY, remainingByGroup.flat());
  });
}

/**
 * Flush exactly ONE connection's queued saves through its client, regardless of that
 * connection's recorded reachability. Two callers:
 *  - reconnect (`provider.tsx onReconnect`): the connection just came back, so replay
 *    its backlog immediately;
 *  - teardown (sign-out / remove-connection): its queued saves are about to be purged,
 *    so make a last-chance attempt to land them even if it's marked offline (the server
 *    being removed may itself still be reachable). If it's genuinely unreachable the
 *    attempt fails and the saves stay queued (then get purged - an offline server's
 *    unsynced saves are unrecoverable either way).
 * Unlike `flushQueue`, it does NOT skip on `isReachable(cid)`; it always tries.
 */
export async function flushConnection(connectionId: string): Promise<void> {
  if (!sessionReady()) return;
  const client = resolveClient(connectionId);
  if (!client) return; // already gone - nothing routable to flush
  await withQueueLock(async () => {
    const queue = await readQueue();
    const mine = queue.filter((s) => s.connectionId === connectionId);
    if (mine.length === 0) return;
    const others = queue.filter((s) => s.connectionId !== connectionId);
    const remaining = await flushGroup(connectionId, client, mine);
    await setItem(QUEUE_KEY, [...others, ...remaining]);
  });
}

// Removing a connection orphans its scoped state forever (re-adding mints a new id),
// so drop its mirror records and queued saves here.
onConnectionRemoved(async (id) => {
  // The mirror and queue take independent locks and touch disjoint storage keys, so
  // purge them concurrently rather than serializing the two storage round-trips.
  await Promise.all([
    withMirrorLock(async () => {
      const map = await readMirrorMap();
      let changed = false;
      for (const [key, save] of Object.entries(map)) {
        if (save.connectionId === id) {
          delete map[key];
          changed = true;
        }
      }
      if (changed) await setItem(MIRROR_KEY, map);
    }),
    withQueueLock(async () => {
      const queue = await readQueue();
      const next = queue.filter((s) => s.connectionId !== id);
      if (next.length !== queue.length) await setItem(QUEUE_KEY, next);
    }),
  ]);
});
