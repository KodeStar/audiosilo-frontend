import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiError, type ApiClient } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import * as reachability from '@/api/reachability';
import type { ReadingProgress, ReadingProgressSaved } from '@/api/types';
import { READING_MIRROR_KEY, READING_QUEUE_KEY } from '@/lib/storage-keys';
import { onConnectionRemoved } from '@/stores/session';

import {
  adoptServerPlace,
  captureReadingSave,
  flushReadingConnection,
  flushReadingQueue,
  jumpOffer,
  lookupReadingPlace,
  onReadingSaved,
  type ReadingSave,
  saveReadingPlace,
} from './reading-progress';

// The same seams as progress-sync.test.ts: reachability per connection, a client per
// connection, and the session's removal hook (captured below).
jest.mock('@/api/reachability', () => ({
  isReachable: jest.fn(() => true),
  noteFailure: jest.fn(),
  noteSuccess: jest.fn(),
}));
jest.mock('@/api/connection-clients', () => ({
  resolveClient: jest.fn(() => null),
  sessionReady: jest.fn(() => true),
}));
jest.mock('@/stores/session', () => ({
  onConnectionRemoved: jest.fn(() => () => {}),
}));

// progress-sync (imported for getDeviceId) registers first; the reader's purge is the last.
const removalCleanup = (onConnectionRemoved as jest.Mock).mock.calls.at(-1)?.[0] as (
  id: string,
) => Promise<void>;

const reachable = reachability.isReachable as jest.Mock;
const mockResolveClient = resolveClient as jest.Mock;
const mockSessionReady = sessionReady as jest.Mock;

const CFI_A = 'epubcfi(/6/4!/4/2/1:0)';
const CFI_B = 'epubcfi(/6/12!/4/2/1:0)';

function row(p: Partial<ReadingProgress> = {}): ReadingProgress {
  return {
    library_id: 1,
    path: 'A/Book',
    cfi: CFI_A,
    progression: 0.2,
    version: 1,
    device_id: 'dev',
    device_name: 'This browser',
    updated_at: '2026-10-01T10:00:00.000Z',
    ...p,
  };
}

function save(p: Partial<ReadingSave> = {}): ReadingSave {
  return {
    connectionId: 'c1',
    libraryId: 1,
    path: 'A/Book',
    cfi: CFI_A,
    progression: 0.2,
    device_id: 'dev',
    updated_at: '2026-10-01T10:00:00.000Z',
    base_version: 0,
    ...p,
  };
}

/** An api whose PUT answers with the save as the kept row at `version` (or fails). */
function fakeApi(
  impl: (input: Record<string, unknown>) => Promise<ReadingProgressSaved> = async (input) => ({
    reading_progress: row({ ...(input as Partial<ReadingProgress>), version: 5 }),
  }),
  get: () => Promise<ReadingProgress | null> = async () => null,
) {
  return {
    saveReadingProgress: jest.fn((_lib: number, _path: string, input: Record<string, unknown>) =>
      impl(input),
    ),
    readingProgress: jest.fn(get),
  } as unknown as ApiClient & { saveReadingProgress: jest.Mock; readingProgress: jest.Mock };
}

async function stored<T>(key: string, fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(key);
  return raw ? (JSON.parse(raw) as T) : fallback;
}
const readQueue = () => stored<ReadingSave[]>(READING_QUEUE_KEY, []);
const readMirror = () =>
  stored<Record<string, { place: { cfi: string } | null; version: number }>>(
    READING_MIRROR_KEY,
    {},
  );

describe('reading-progress', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    reachable.mockReset().mockReturnValue(true);
    mockResolveClient.mockReset().mockReturnValue(null);
    mockSessionReady.mockReset().mockReturnValue(true);
  });

  it('saves straight away when reachable, sending only the wire fields', async () => {
    const api = fakeApi();
    await saveReadingPlace(api, save({ base_version: 3 }));
    expect(api.saveReadingProgress).toHaveBeenCalledWith(1, 'A/Book', {
      cfi: CFI_A,
      progression: 0.2,
      device_id: 'dev',
      updated_at: '2026-10-01T10:00:00.000Z',
      base_version: 3,
    });
    expect(reachability.noteSuccess).toHaveBeenCalledWith('c1');
    expect(await readQueue()).toEqual([]);
  });

  it('queues offline without a request, the latest save per book winning', async () => {
    reachable.mockReturnValue(false);
    const api = fakeApi();
    await saveReadingPlace(api, save({ cfi: CFI_A }));
    await saveReadingPlace(api, save({ cfi: CFI_B, updated_at: '2026-10-01T10:05:00.000Z' }));
    await saveReadingPlace(api, save({ path: 'B/Other' }));
    expect(api.saveReadingProgress).not.toHaveBeenCalled();
    const queue = await readQueue();
    expect(queue).toHaveLength(2);
    expect(queue.find((s) => s.path === 'A/Book')?.cfi).toBe(CFI_B);
  });

  it('queues with no client at all', async () => {
    await saveReadingPlace(null, save());
    expect(await readQueue()).toHaveLength(1);
  });

  it('drops a save the server refuses (4xx): it can never succeed', async () => {
    const api = fakeApi(() => Promise.reject(new ApiError(400, 'bad cfi')));
    await expect(saveReadingPlace(api, save())).resolves.toBeNull();
    expect(await readQueue()).toEqual([]);
    expect(reachability.noteFailure).not.toHaveBeenCalled();
  });

  it('queues a save that failed on the network or a 5xx', async () => {
    await saveReadingPlace(
      fakeApi(() => Promise.reject(new TypeError('offline'))),
      save(),
    );
    expect(await readQueue()).toHaveLength(1);
    expect(reachability.noteFailure).toHaveBeenCalledWith('c1', expect.any(TypeError));
    await AsyncStorage.clear();
    await saveReadingPlace(
      fakeApi(() => Promise.reject(new ApiError(503, 'busy'))),
      save(),
    );
    expect(await readQueue()).toHaveLength(1);
  });

  it('captures base_version as the last acknowledged version (0 when none)', async () => {
    expect(
      (await captureReadingSave('c1', 1, 'A/Book', { cfi: CFI_A, progression: 0.2 })).base_version,
    ).toBe(0);
    await saveReadingPlace(fakeApi(), save());
    const next = await captureReadingSave('c1', 1, 'A/Book', { cfi: CFI_B, progression: 1.4 });
    expect(next.base_version).toBe(5);
    expect(next.progression).toBe(1);
    expect(next.device_id).toEqual(expect.any(String));
  });

  it('a queued save keeps its base, and the version the flush answers is adopted', async () => {
    reachable.mockReturnValue(false);
    await saveReadingPlace(null, save({ base_version: 2 }));
    reachable.mockReturnValue(true);
    const api = fakeApi(async (input) => ({
      reading_progress: row({ ...(input as Partial<ReadingProgress>), version: 9 }),
    }));
    routeClients({ c1: api });
    await flushReadingQueue();
    expect(api.saveReadingProgress).toHaveBeenCalledWith(
      1,
      'A/Book',
      expect.objectContaining({ base_version: 2 }),
    );
    expect(await readQueue()).toEqual([]);
    const mirror = Object.values(await readMirror());
    expect(mirror[0].version).toBe(9);
    const next = await captureReadingSave('c1', 1, 'A/Book', { cfi: CFI_B, progression: 0.5 });
    expect(next.base_version).toBe(9);
  });

  it('replays each save through its own connection, keeping those that fail', async () => {
    reachable.mockReturnValue(false);
    await saveReadingPlace(null, save({ connectionId: 'c1' }));
    await saveReadingPlace(null, save({ connectionId: 'c2' }));
    reachable.mockReturnValue(true);
    const one = fakeApi();
    const two = fakeApi(() => Promise.reject(new TypeError('down')));
    routeClients({ c1: one, c2: two });
    await flushReadingQueue();
    expect(one.saveReadingProgress).toHaveBeenCalledTimes(1);
    expect(two.saveReadingProgress).toHaveBeenCalledTimes(1);
    expect((await readQueue()).map((s) => s.connectionId)).toEqual(['c2']);
  });

  it('waits for the session before replaying', async () => {
    await saveReadingPlace(null, save());
    mockSessionReady.mockReturnValue(false);
    const api = fakeApi();
    routeClients({ c1: api });
    await flushReadingQueue();
    expect(api.saveReadingProgress).not.toHaveBeenCalled();
    expect(await readQueue()).toHaveLength(1);
  });

  it('flushes one connection whatever its recorded reachability', async () => {
    reachable.mockReturnValue(false);
    await saveReadingPlace(null, save({ connectionId: 'c1' }));
    await saveReadingPlace(null, save({ connectionId: 'c2' }));
    const api = fakeApi();
    routeClients({ c1: api });
    await flushReadingConnection('c1');
    expect(api.saveReadingProgress).toHaveBeenCalledTimes(1);
    expect((await readQueue()).map((s) => s.connectionId)).toEqual(['c2']);
  });

  it('acknowledges another device’s kept place only once the reader has shown it', async () => {
    await adoptServerPlace('c1', 1, 'A/Book', row({ version: 5 }));
    reachable.mockReturnValue(false);
    await saveReadingPlace(null, save({ cfi: CFI_A, updated_at: '2026-10-03T00:00:00.000Z' }));
    reachable.mockReturnValue(true);
    // The server kept the phone's further place: this device never saw it.
    const phone = row({ device_id: 'phone', cfi: CFI_B, progression: 0.6, version: 9 });
    routeClients({ c1: fakeApi(async () => ({ reading_progress: phone })) });
    await flushReadingQueue();
    const unseen = await captureReadingSave('c1', 1, 'A/Book', { cfi: CFI_A, progression: 0.3 });
    expect(unseen.base_version).toBe(5);
    expect(Object.values(await readMirror())[0].place?.cfi).toBe(CFI_A);
    // Jump or Stay (or the reader already there): seen, so the next save applies.
    await adoptServerPlace('c1', 1, 'A/Book', phone);
    const seen = await captureReadingSave('c1', 1, 'A/Book', { cfi: CFI_A, progression: 0.3 });
    expect(seen.base_version).toBe(9);
  });

  it('tells listeners every answer', async () => {
    const heard = jest.fn();
    const off = onReadingSaved(heard);
    await saveReadingPlace(fakeApi(), save());
    off();
    await saveReadingPlace(fakeApi(), save());
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][0]).toMatchObject({ connectionId: 'c1', path: 'A/Book' });
  });

  describe('where the reader opens', () => {
    it('opens at the server row when it is the newest, and says so', async () => {
      const server = row({ cfi: CFI_B, updated_at: '2026-10-02T00:00:00.000Z', version: 4 });
      const api = fakeApi(undefined, async () => server);
      await saveReadingPlace(null, save({ cfi: CFI_A }));
      const found = await lookupReadingPlace(api, 'c1', 1, 'A/Book');
      expect(found.place?.cfi).toBe(CFI_B);
      expect(found.fromServer).toBe(server);
    });

    it('opens at a newer local place (queued or mirrored) over the server row', async () => {
      const api = fakeApi(undefined, async () => row({ cfi: CFI_A }));
      reachable.mockReturnValue(false);
      await saveReadingPlace(null, save({ cfi: CFI_B, updated_at: '2026-10-05T00:00:00.000Z' }));
      const found = await lookupReadingPlace(api, 'c1', 1, 'A/Book');
      expect(found.place?.cfi).toBe(CFI_B);
      expect(found.fromServer).toBeNull();
    });

    it('opens at the local place when the server cannot be reached, and notes it', async () => {
      await saveReadingPlace(null, save({ cfi: CFI_B }));
      const api = fakeApi(undefined, () => Promise.reject(new TypeError('offline')));
      const found = await lookupReadingPlace(api, 'c1', 1, 'A/Book');
      expect(found.place?.cfi).toBe(CFI_B);
      expect(reachability.noteFailure).toHaveBeenCalled();
    });

    it('opens at the start when the server has no place for the book', async () => {
      await expect(lookupReadingPlace(fakeApi(), 'c1', 1, 'A/Book')).resolves.toEqual({
        place: null,
        fromServer: null,
      });
    });

    it('fails with the server’s refusal when nothing is local (a 404: no ebook)', async () => {
      const api = fakeApi(undefined, () => Promise.reject(new ApiError(404, 'no ebook')));
      await expect(lookupReadingPlace(api, 'c1', 1, 'A/Book')).rejects.toMatchObject({
        status: 404,
      });
      expect(reachability.noteSuccess).toHaveBeenCalledWith('c1');
    });

    it('fails rather than open at the start with no answer and nothing local', async () => {
      for (const failure of [new TypeError('offline'), new ApiError(500, 'db')]) {
        const api = fakeApi(undefined, () => Promise.reject(failure));
        await expect(lookupReadingPlace(api, 'c1', 1, 'A/Book')).rejects.toBe(failure);
      }
      await expect(lookupReadingPlace(null, 'c1', 1, 'A/Book')).rejects.toThrow();
    });

    it('fails on a signed-out answer (401) whatever is local', async () => {
      await saveReadingPlace(null, save({ cfi: CFI_B }));
      const signedOut = new ApiError(401, 'unauthorized');
      const api = fakeApi(undefined, () => Promise.reject(signedOut));
      await expect(lookupReadingPlace(api, 'c1', 1, 'A/Book')).rejects.toBe(signedOut);
    });

    it('opens at a queued save the server will keep: diverged and further on', async () => {
      const server = row({
        device_id: 'phone',
        progression: 0.4,
        version: 5,
        updated_at: '2026-10-02T00:00:00.000Z',
      });
      reachable.mockReturnValue(false);
      await saveReadingPlace(
        null,
        save({
          cfi: CFI_B,
          progression: 0.7,
          base_version: 3,
          updated_at: '2026-10-01T00:00:00.000Z',
        }),
      );
      const found = await lookupReadingPlace(
        fakeApi(undefined, async () => server),
        'c1',
        1,
        'A/Book',
      );
      expect(found.place?.cfi).toBe(CFI_B);
      expect(found.fromServer).toBeNull();
    });

    it('opens at the newer server row over a diverged queued save behind it', async () => {
      const server = row({
        device_id: 'phone',
        cfi: CFI_B,
        progression: 0.6,
        version: 5,
        updated_at: '2026-10-02T00:00:00.000Z',
      });
      reachable.mockReturnValue(false);
      await saveReadingPlace(
        null,
        save({ progression: 0.3, base_version: 3, updated_at: '2026-10-01T00:00:00.000Z' }),
      );
      const found = await lookupReadingPlace(
        fakeApi(undefined, async () => server),
        'c1',
        1,
        'A/Book',
      );
      expect(found.place?.cfi).toBe(CFI_B);
      expect(found.fromServer).toBe(server);
    });

    it('adopting the server row makes the next save on its version', async () => {
      await adoptServerPlace('c1', 1, 'A/Book', row({ version: 7 }));
      const next = await captureReadingSave('c1', 1, 'A/Book', { cfi: CFI_B, progression: 0.3 });
      expect(next.base_version).toBe(7);
    });
  });

  it('forgets a removed connection’s places and queued saves', async () => {
    await saveReadingPlace(null, save({ connectionId: 'c1' }));
    await saveReadingPlace(null, save({ connectionId: 'c2' }));
    await removalCleanup('c1');
    expect((await readQueue()).map((s) => s.connectionId)).toEqual(['c2']);
    expect(Object.values(await readMirror())).toHaveLength(1);
  });
});

describe('jumpOffer', () => {
  const kept = (p: Partial<ReadingProgress>): ReadingProgressSaved => ({
    reading_progress: row({ device_id: 'phone', device_name: 'Pixel 8', ...p }),
  });

  it('offers the place another device kept when it is somewhere else', () => {
    expect(
      jumpOffer(kept({ cfi: CFI_B, progression: 0.6 }), { cfi: CFI_A, progression: 0.2 }, 'dev'),
    ).toEqual({ cfi: CFI_B, progression: 0.6, deviceName: 'Pixel 8' });
  });

  it('offers nothing when the kept row is this device’s own (other_place or not)', () => {
    const answer: ReadingProgressSaved = {
      reading_progress: row({ device_id: 'dev', cfi: CFI_B, progression: 0.6 }),
      other_place: {
        cfi: CFI_A,
        progression: 0.2,
        device_id: 'phone',
        device_name: 'Pixel 8',
        updated_at: '2026-10-01T10:00:00.000Z',
      },
    };
    expect(jumpOffer(answer, { cfi: CFI_A, progression: 0.2 }, 'dev')).toBeNull();
  });

  it('offers nothing when the kept place is where the reader is', () => {
    expect(jumpOffer(kept({ cfi: CFI_A }), { cfi: CFI_A, progression: 0.2 }, 'dev')).toBeNull();
    expect(
      jumpOffer(kept({ cfi: CFI_B, progression: 0.205 }), { cfi: CFI_A, progression: 0.2 }, 'dev'),
    ).toBeNull();
  });

  it('names no device when the server has no name for it', () => {
    expect(
      jumpOffer(
        kept({ cfi: CFI_B, progression: 0.6, device_name: undefined }),
        { cfi: CFI_A, progression: 0.2 },
        'dev',
      )?.deviceName,
    ).toBe('');
  });
});

function routeClients(map: Record<string, ApiClient | null>) {
  mockResolveClient.mockImplementation((cid: string) => map[cid] ?? null);
}
