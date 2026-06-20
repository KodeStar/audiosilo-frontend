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

export async function loadInitialProgress(
  api: ApiClient,
  libraryId: number,
  path: string,
): Promise<Progress | null> {
  try {
    const server = await api.getProgress(libraryId, path);
    if (server) return server;
  } catch (e) {
    noteError(e); // offline or unreachable — fall back to the latest local save below
  }
  return pendingProgressFor(libraryId, path);
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
