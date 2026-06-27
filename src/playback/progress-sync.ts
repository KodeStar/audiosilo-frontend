import { ApiError, type ApiClient } from '@/api/client';
import {
  getReachabilityApi,
  isReachable,
  noteError,
  noteSuccess,
  onReconnect,
} from '@/api/reachability';
import type { Progress } from '@/api/types';
import { getItem, setItem } from '@/lib/storage';

// When the server comes back, replay anything that piled up while it was away.
onReconnect(() => {
  const api = getReachabilityApi();
  if (api) void flushQueue(api);
});

const QUEUE_KEY = 'audiosilo.progressQueue';
const DEVICE_KEY = 'audiosilo.deviceId';
// Durable, never-pruned mirror of the last-known progress per (library, path). Unlike
// the offline queue (cleared once a save syncs), this survives sync so a returning
// listener can resume even when the server momentarily can't be reached — the fix for
// "an in-progress book restarted from 0 because the resume fetch failed".
const MIRROR_KEY = 'audiosilo.progressMirror';

let deviceIdCache: string | null = null;

function mirrorKey(libraryId: number, path: string): string {
  return `${libraryId}:${path}`;
}

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

export async function loadInitialProgress(
  api: ApiClient,
  libraryId: number,
  path: string,
): Promise<ResumeLookup> {
  let serverOk = false;
  let server: Progress | null = null;
  try {
    server = await api.getProgress(libraryId, path); // null = HTTP 200, no record (new book)
    serverOk = true;
  } catch (e) {
    noteError(e); // offline or unreachable — reconcile with local sources below
  }
  // Cache the authoritative server value so a later offline resume has it (keep-newest,
  // so a locally-newer offline advance isn't regressed by a stale server read).
  if (serverOk && server) await writeMirror(progressToSave(libraryId, path, server));

  const mirror = mirrorAsProgress(libraryId, path, await readMirror(libraryId, path));
  const queued = await pendingProgressFor(libraryId, path);
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

function progressToSave(libraryId: number, path: string, p: Progress): ProgressSave {
  return {
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
    const map = (await getItem<Record<string, ProgressSave>>(MIRROR_KEY)) ?? {};
    const key = mirrorKey(save.libraryId, save.path);
    const existing = map[key];
    if (!existing || Date.parse(save.updated_at) >= Date.parse(existing.updated_at)) {
      map[key] = save;
      await setItem(MIRROR_KEY, map);
    }
  });
}

export async function readMirror(libraryId: number, path: string): Promise<ProgressSave | null> {
  const map = (await getItem<Record<string, ProgressSave>>(MIRROR_KEY)) ?? {};
  return map[mirrorKey(libraryId, path)] ?? null;
}

/** Reconstruct progress from the offline replay queue, so a downloaded book
 * resumes at the right spot when the server can't be reached. */
async function pendingProgressFor(libraryId: number, path: string): Promise<Progress | null> {
  const queue = (await getItem<ProgressSave[]>(QUEUE_KEY)) ?? [];
  const save = queue.find((s) => s.libraryId === libraryId && s.path === path);
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
  // Always record the latest position in the durable mirror, independent of the network
  // outcome — this is what a future resume falls back to when the server can't be reached.
  await writeMirror(save);
  // Server known to be unreachable: queue locally without hitting the network, so
  // the 15s save loop doesn't fire a doomed request every tick while offline.
  if (!isReachable()) {
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
    noteSuccess();
    void flushQueue(api);
  } catch (e) {
    if (isUnrecoverable(e)) return; // auth/forbidden — don't retry forever
    noteError(e); // a connection error flips us offline (stops further attempts)
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
    const queue = (await getItem<ProgressSave[]>(QUEUE_KEY)) ?? [];
    // Keep only the latest pending save per (library, path).
    const next = queue.filter((s) => !(s.libraryId === save.libraryId && s.path === save.path));
    next.push(save);
    await setItem(QUEUE_KEY, next);
  });
}

/** Replay queued saves (call on reconnect / app open). */
export async function flushQueue(api: ApiClient): Promise<void> {
  if (!isReachable()) return; // wait for reconnect rather than fail item by item
  await withQueueLock(async () => {
    const queue = (await getItem<ProgressSave[]>(QUEUE_KEY)) ?? [];
    if (queue.length === 0) return;
    const remaining: ProgressSave[] = [];
    for (let i = 0; i < queue.length; i++) {
      const save = queue[i];
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
        noteSuccess();
      } catch (e) {
        if (isUnrecoverable(e)) continue; // drop; can't ever succeed
        noteError(e);
        if (!isReachable()) {
          // Connection dropped mid-flush — keep this and everything after it.
          remaining.push(...queue.slice(i));
          break;
        }
        remaining.push(save); // transient server error — retry next time
      }
    }
    await setItem(QUEUE_KEY, remaining);
  });
}
