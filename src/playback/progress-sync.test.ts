import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiClient, ApiError } from '@/api/client';
import * as reachability from '@/api/reachability';
import type { Progress } from '@/api/types';
import {
  flushQueue,
  loadInitialProgress,
  type ProgressSave,
  saveProgress,
} from '@/playback/progress-sync';

// babel-jest hoists jest.mock above the imports, so the module under test sees the
// mock at import time (it calls onReconnect() and gates every save on isReachable()).
jest.mock('@/api/reachability', () => ({
  isReachable: jest.fn(() => true),
  noteError: jest.fn(),
  noteSuccess: jest.fn(),
  onReconnect: jest.fn(() => () => {}),
  getReachabilityApi: jest.fn(() => null),
}));

const QUEUE_KEY = 'audiosilo.progressQueue';
const MIRROR_KEY = 'audiosilo.progressMirror';

const save: ProgressSave = {
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

describe('progress-sync', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    reachable.mockReturnValue(true);
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

  it('keeps only the latest pending save per (library, path)', async () => {
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

    const ok = fakeApi(() => Promise.resolve());
    await flushQueue(ok);
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
    await Promise.all([flushQueue(ok), flushQueue(ok)]);

    // Each queued save sent exactly once; the queue is drained, nothing lost.
    expect(ok.saveProgress).toHaveBeenCalledTimes(2);
    expect(await readQueue()).toHaveLength(0);
  });

  // --- durable mirror + resume lookup (never restart an in-progress book from 0) ---

  it('writes the durable mirror on a successful (online) save', async () => {
    const api = fakeApi(() => Promise.resolve());
    await saveProgress(api, { ...save, position: 42 });
    const mirror = await readMirror();
    expect(mirror['1:A/Book']).toMatchObject({ position: 42 });
  });

  it('writes the durable mirror even when offline', async () => {
    reachable.mockReturnValue(false);
    const api = fakeApi(() => Promise.resolve());
    await saveProgress(api, { ...save, position: 17 });
    expect((await readMirror())['1:A/Book']).toMatchObject({ position: 17 });
  });

  it('keeps the mirror after the offline queue is flushed (never pruned on sync)', async () => {
    reachable.mockReturnValue(false);
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      { ...save, position: 80 },
    );
    expect(await readQueue()).toHaveLength(1);

    reachable.mockReturnValue(true);
    await flushQueue(fakeApi(() => Promise.resolve()));
    expect(await readQueue()).toHaveLength(0); // queue drained...
    expect((await readMirror())['1:A/Book']).toMatchObject({ position: 80 }); // ...mirror remains
  });

  it('loadInitialProgress: returns server progress when reachable', async () => {
    const api = fakeGetApi(() => Promise.resolve(makeProgress({ position: 60 })));
    const r = await loadInitialProgress(api, 1, 'A/Book');
    expect(r).toEqual({ kind: 'progress', progress: expect.objectContaining({ position: 60 }) });
  });

  it('loadInitialProgress: returns empty when the server has no record (HTTP 200, null)', async () => {
    const api = fakeGetApi(() => Promise.resolve(null));
    const r = await loadInitialProgress(api, 1, 'A/Book');
    expect(r).toEqual({ kind: 'empty' });
  });

  it('loadInitialProgress: falls back to the mirror when the server is unreachable', async () => {
    // Seed the mirror via a save, then make the fetch throw (offline/5xx).
    await saveProgress(
      fakeApi(() => Promise.resolve()),
      { ...save, position: 75 },
    );
    const api = fakeGetApi(() => Promise.reject(new Error('network down')));
    const r = await loadInitialProgress(api, 1, 'A/Book');
    expect(r).toEqual({ kind: 'progress', progress: expect.objectContaining({ position: 75 }) });
  });

  it('loadInitialProgress: returns failed only when unreachable AND no local record', async () => {
    const api = fakeGetApi(() => Promise.reject(new Error('network down')));
    const r = await loadInitialProgress(api, 1, 'A/Book');
    expect(r).toEqual({ kind: 'failed' });
  });

  it('loadInitialProgress: reconciles by updated_at — newer mirror wins over older server', async () => {
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
    const r = await loadInitialProgress(api, 1, 'A/Book');
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
    const r = await loadInitialProgress(api, 1, 'A/Book');
    expect(r).toMatchObject({ kind: 'progress', progress: { position: 95 } });
  });
});
