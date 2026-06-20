import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiClient, ApiError } from '@/api/client';
import * as reachability from '@/api/reachability';
import { flushQueue, type ProgressSave, saveProgress } from '@/playback/progress-sync';

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

async function readQueue(): Promise<ProgressSave[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  return raw ? (JSON.parse(raw) as ProgressSave[]) : [];
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
    expect(api.saveProgress).toHaveBeenCalledWith(1, 'A/Book', expect.objectContaining({ position: 10 }));
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

  // TODO(review finding F4): two overlapping flushQueue() calls each read the
  // queue and each write it back, so saves enqueued/processed by the other are
  // lost. Fix by serializing queue mutations behind a single in-flight promise,
  // then unskip this test.
  it.skip('serializes concurrent flushes without losing queued saves', () => {
    // Intentionally skipped until the serialization refactor lands.
  });
});
