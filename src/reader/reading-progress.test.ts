import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiError, type ApiClient, TimeoutError } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import * as reachability from '@/api/reachability';
import type { ReadingProgress, ReadingProgressSaved } from '@/api/types';
import { READING_MIRROR_KEY, READING_QUEUE_KEY } from '@/lib/storage-keys';
import { getDeviceId } from '@/playback/progress-sync';
import { onConnectionRemoved } from '@/stores/session';

import {
  adoptServerPlace,
  captureReadingSave,
  flushReadingConnection,
  flushReadingQueue,
  jumpOffer,
  lookupReadingPlace,
  onReadingRefused,
  onReadingSaved,
  type ReadingRefused,
  type ReadingSave,
  type ReadingSaved,
  saveReaderPlace,
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
// The app's EPUB cache (ebook-file.native.ts has its own tests): dropped with its connection.
const mockClearEbookCache = jest.fn(async (_id: string) => {});
jest.mock('./ebook-file', () => ({
  clearEbookCache: (id: string) => mockClearEbookCache(id),
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
const CFI_C = 'epubcfi(/6/30!/4/2/1:0)';

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

/** A server keeping the book's one row by catalog.ResolvePlace's rule: a save diverges when
 * a row is stored and its base is not the row's version, from another device or on 0 (saw
 * nothing, whatever the device); a diverged save keeps the further place, any other is
 * latest-wins. Every applied save bumps the version. */
function ruleServer(deviceName: string) {
  let kept: ReadingProgress | null = null;
  const api = fakeApi(
    async (input) => {
      const save = input as Pick<
        ReadingSave,
        'cfi' | 'progression' | 'device_id' | 'updated_at' | 'base_version'
      >;
      const apply = () => {
        kept = row({
          cfi: save.cfi,
          progression: save.progression,
          device_id: save.device_id,
          device_name: deviceName,
          updated_at: save.updated_at,
          version: (kept?.version ?? 0) + 1,
        });
      };
      if (!kept) apply();
      else if (
        save.base_version !== kept.version &&
        (save.base_version === 0 || save.device_id !== kept.device_id)
      ) {
        if (save.progression > kept.progression) apply();
      } else if (Date.parse(save.updated_at) >= Date.parse(kept.updated_at)) apply();
      return { reading_progress: kept! };
    },
    async () => kept,
  );
  return { api, row: () => kept };
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

  it('queues a save the server says to try later (429 rate limit, 408), telling no one', async () => {
    const heard: ReadingRefused[] = [];
    const stop = onReadingRefused((r) => heard.push(r));
    try {
      for (const status of [429, 408]) {
        const api = fakeApi(() => Promise.reject(new ApiError(status, 'later')));
        await expect(saveReadingPlace(api, save({ path: `B/${status}` }))).resolves.toBeNull();
      }
      expect((await readQueue()).map((s) => s.path)).toEqual(['B/429', 'B/408']);
      expect(heard).toEqual([]);
    } finally {
      stop();
    }
  });

  it('tells listeners a refused save, sent or replayed, and nothing else (CONNECT-04)', async () => {
    const heard: ReadingRefused[] = [];
    const stop = onReadingRefused((r) => heard.push(r));
    try {
      await saveReadingPlace(
        fakeApi(() => Promise.reject(new ApiError(401, 'unauthorized'))),
        save(),
      );
      await saveReadingPlace(
        fakeApi(() => Promise.reject(new TypeError('offline'))),
        save({ path: 'B/Queued' }),
      );
      await saveReadingPlace(fakeApi(), save({ path: 'C/Saved' }));
      expect(heard).toEqual([{ connectionId: 'c1', libraryId: 1, path: 'A/Book', status: 401 }]);

      // The queued save's replay is refused too (its access went meanwhile).
      routeClients({ c1: fakeApi(() => Promise.reject(new ApiError(403, 'forbidden'))) });
      await flushReadingQueue();
      expect(heard.at(-1)).toEqual({
        connectionId: 'c1',
        libraryId: 1,
        path: 'B/Queued',
        status: 403,
      });
      expect(await readQueue()).toEqual([]);
    } finally {
      stop();
    }
    await saveReadingPlace(
      fakeApi(() => Promise.reject(new ApiError(401, 'unauthorized'))),
      save(),
    );
    expect(heard).toHaveLength(2);
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

    it('opens a book on this device at the start offline with no place anywhere', async () => {
      const hasLocalCopy = jest.fn(async () => true);
      for (const api of [
        fakeApi(undefined, () => Promise.reject(new TypeError('Network request failed'))),
        fakeApi(undefined, () => Promise.reject(new Error('The Internet connection is offline'))),
      ]) {
        await expect(
          lookupReadingPlace(api, 'c1', 1, 'A/Book', undefined, { hasLocalCopy }),
        ).resolves.toEqual({ place: null, fromServer: null });
      }
      expect(hasLocalCopy).toHaveBeenCalled();
    });

    it('fails on a timeout rather than open at the start: a slow server is up (fe#173)', async () => {
      const hasLocalCopy = jest.fn(async () => true);
      const slow = new TimeoutError(15000);
      await expect(
        lookupReadingPlace(
          fakeApi(undefined, () => Promise.reject(slow)),
          'c1',
          1,
          'A/Book',
          undefined,
          { hasLocalCopy },
        ),
      ).rejects.toBe(slow);
      expect(hasLocalCopy).not.toHaveBeenCalled();
      // A place on this device still opens there.
      await saveReadingPlace(null, save({ cfi: CFI_B }));
      await expect(
        lookupReadingPlace(
          fakeApi(undefined, () => Promise.reject(slow)),
          'c1',
          1,
          'A/Book',
          undefined,
          { hasLocalCopy },
        ),
      ).resolves.toMatchObject({ place: { cfi: CFI_B }, fromServer: null });
    });

    it('opens at the start on a timeout once the server is found down: every request hangs', async () => {
      // A home address away from home: the reachability check timed out too.
      reachable.mockReturnValue(false);
      const hasLocalCopy = jest.fn(async () => true);
      await expect(
        lookupReadingPlace(
          fakeApi(undefined, () => Promise.reject(new TimeoutError(15000))),
          'c1',
          1,
          'A/Book',
          undefined,
          { hasLocalCopy },
        ),
      ).resolves.toEqual({ place: null, fromServer: null });
      expect(hasLocalCopy).toHaveBeenCalled();
    });

    it('still fails offline when the EPUB is not on this device (or the check fails)', async () => {
      const offline = new TypeError('offline');
      const api = fakeApi(undefined, () => Promise.reject(offline));
      for (const hasLocalCopy of [
        async () => false,
        () => Promise.reject(new Error('fs')),
        undefined,
      ]) {
        await expect(
          lookupReadingPlace(api, 'c1', 1, 'A/Book', undefined, { hasLocalCopy }),
        ).rejects.toBe(offline);
      }
    });

    it('never opens at a guessed start online: a server error fails it, local copy or not', async () => {
      const hasLocalCopy = jest.fn(async () => true);
      for (const failure of [new ApiError(500, 'db'), new ApiError(404, 'no ebook')]) {
        const api = fakeApi(undefined, () => Promise.reject(failure));
        await expect(
          lookupReadingPlace(api, 'c1', 1, 'A/Book', undefined, { hasLocalCopy }),
        ).rejects.toBe(failure);
      }
      const signedOut = new ApiError(401, 'unauthorized');
      await expect(
        lookupReadingPlace(
          fakeApi(undefined, () => Promise.reject(signedOut)),
          'c1',
          1,
          'A/Book',
          undefined,
          { hasLocalCopy },
        ),
      ).rejects.toBe(signedOut);
      await expect(
        lookupReadingPlace(null, 'c1', 1, 'A/Book', undefined, { hasLocalCopy }),
      ).rejects.toThrow();
      expect(hasLocalCopy).not.toHaveBeenCalled();
    });

    it('prefers a local place over the start offline, without asking for the copy', async () => {
      await saveReadingPlace(null, save({ cfi: CFI_B }));
      const hasLocalCopy = jest.fn(async () => true);
      const api = fakeApi(undefined, () => Promise.reject(new TypeError('offline')));
      const found = await lookupReadingPlace(api, 'c1', 1, 'A/Book', undefined, {
        hasLocalCopy,
      });
      expect(found.place?.cfi).toBe(CFI_B);
      expect(hasLocalCopy).not.toHaveBeenCalled();
    });

    it('an offline start saves on version 0, never acknowledging the place another device kept', async () => {
      // Opened offline at the start: no place, no version, seen here.
      const offline = fakeApi(undefined, () => Promise.reject(new TypeError('offline')));
      await lookupReadingPlace(offline, 'c1', 1, 'A/Book', undefined, {
        hasLocalCopy: async () => true,
      });
      reachable.mockReturnValue(false);
      const first = await captureReadingSave('c1', 1, 'A/Book', { cfi: CFI_A, progression: 0.01 });
      expect(first.base_version).toBe(0);
      await saveReadingPlace(offline, first);
      // A later page of the same session is still made on version 0.
      const next = await captureReadingSave('c1', 1, 'A/Book', { cfi: CFI_B, progression: 0.02 });
      expect(next.base_version).toBe(0);
      await saveReadingPlace(offline, next);
      expect(await readQueue()).toEqual([expect.objectContaining({ base_version: 0 })]);

      // Back online: the server took version 0 as diverged and kept the phone's place
      // further on (catalog.ResolvePlace); the answer offers Jump there and leaves this
      // device's version at 0 until the reader shows it.
      const kept = row({
        device_id: 'phone',
        device_name: 'Pixel 8',
        cfi: CFI_C,
        progression: 0.6,
        version: 9,
      });
      const online = fakeApi(async () => ({ reading_progress: kept }));
      mockResolveClient.mockReturnValue(online);
      reachable.mockReturnValue(true);
      const heard: ReadingSaved[] = [];
      const off = onReadingSaved((a) => heard.push(a));
      await flushReadingQueue();
      off();
      expect(online.saveReadingProgress).toHaveBeenCalledWith(
        1,
        'A/Book',
        expect.objectContaining({ base_version: 0, progression: 0.02 }),
      );
      expect(heard).toEqual([expect.objectContaining({ saved: { reading_progress: kept } })]);
      expect(jumpOffer(heard[0], { cfi: CFI_B, progression: 0.02 })).toMatchObject({
        progression: 0.6,
        deviceName: 'Pixel 8',
      });
      const after = await captureReadingSave('c1', 1, 'A/Book', { cfi: CFI_A, progression: 0.03 });
      expect(after.base_version).toBe(0);
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

  describe('this device’s own place', () => {
    const START = 'epubcfi(/6/2!/4/2/1:0)';
    const at = (cfi: string, progression: number) =>
      captureReadingSave('c1', 1, 'A/Book', { cfi, progression });

    it('adopts its own saves’ versions, answered in order', async () => {
      const server = ruleServer('This phone');
      const heard: ReadingSaved[] = [];
      const off = onReadingSaved((a) => heard.push(a));
      const bases: number[] = [];
      for (const [cfi, progression] of [
        [CFI_A, 0.2],
        [CFI_C, 0.8],
        [CFI_B, 0.5],
      ] as const) {
        const next = await at(cfi, progression);
        bases.push(next.base_version);
        await saveReadingPlace(server.api, next);
      }
      off();
      expect(bases).toEqual([0, 1, 2]);
      expect(heard.map((a) => a.seen)).toEqual([true, true, true]);
      // Moving back on purpose applied.
      expect(server.row()).toMatchObject({ cfi: CFI_B, progression: 0.5, version: 3 });
      expect((await at(CFI_B, 0.51)).base_version).toBe(3);
    });

    it('signed out and back in, a start saved offline keeps its place further on and offers Jump', async () => {
      const deviceId = await getDeviceId();
      const server = ruleServer('This phone');
      mockResolveClient.mockReturnValue(server.api);
      // Read to 80% online.
      for (const [cfi, progression] of [
        [CFI_A, 0.2],
        [CFI_C, 0.8],
      ] as const) {
        await saveReadingPlace(server.api, await at(cfi, progression));
      }
      expect(server.row()).toMatchObject({ progression: 0.8, version: 2, device_id: deviceId });
      // Signed out (onConnectionRemoved): the places here are gone, the device id is not.
      await removalCleanup('c1');
      expect(await readMirror()).toEqual({});
      expect(await getDeviceId()).toBe(deviceId);

      // The downloaded book opens offline at the start; its save is queued on 0.
      const offline = fakeApi(undefined, () => Promise.reject(new TypeError('offline')));
      await expect(
        lookupReadingPlace(offline, 'c1', 1, 'A/Book', undefined, {
          hasLocalCopy: async () => true,
        }),
      ).resolves.toEqual({ place: null, fromServer: null });
      reachable.mockReturnValue(false);
      const start = await at(START, 0.01);
      expect(start.base_version).toBe(0);
      await saveReadingPlace(offline, start);
      expect(offline.saveReadingProgress).not.toHaveBeenCalled();

      // Back online, the replay: the server keeps 80%, which this device never saw.
      reachable.mockReturnValue(true);
      const heard: ReadingSaved[] = [];
      const off = onReadingSaved((a) => heard.push(a));
      await flushReadingQueue();
      off();
      expect(server.row()).toMatchObject({ progression: 0.8, version: 2 });
      expect(heard).toHaveLength(1);
      expect(heard[0].seen).toBe(false);
      expect(jumpOffer(heard[0], { cfi: START, progression: 0.01 })).toEqual({
        cfi: CFI_C,
        progression: 0.8,
        deviceName: 'This phone',
      });
      // Not acknowledged: the next save is still on 0, and still never moves it back.
      const next = await at(START, 0.02);
      expect(next.base_version).toBe(0);
      await saveReadingPlace(server.api, next);
      expect(server.row()).toMatchObject({ progression: 0.8, version: 2 });
      // Stay: seen, so the next save moves back on purpose.
      await adoptServerPlace('c1', 1, 'A/Book', heard[0].saved.reading_progress);
      const stay = await at(START, 0.03);
      expect(stay.base_version).toBe(2);
      await saveReadingPlace(server.api, stay);
      expect(server.row()).toMatchObject({ progression: 0.03, version: 3 });
    });

    it('sends the reader’s first two saves one after the other, so a move back applies', async () => {
      const server = ruleServer('This phone');
      const heard: ReadingSaved[] = [];
      const off = onReadingSaved((a) => heard.push(a));
      // Both fire before the first is answered; the second is a page back.
      await Promise.all([
        saveReaderPlace(server.api, 'c1', 1, 'A/Book', { cfi: CFI_B, progression: 0.5 }),
        saveReaderPlace(server.api, 'c1', 1, 'A/Book', { cfi: CFI_A, progression: 0.3 }),
      ]);
      off();
      expect(server.api.saveReadingProgress.mock.calls.map(([, , b]) => b.base_version)).toEqual([
        0, 1,
      ]);
      expect(heard.map((a) => a.seen)).toEqual([true, true]);
      expect(heard.map((a) => jumpOffer(a, { cfi: CFI_A, progression: 0.3 }))).toEqual([
        null,
        null,
      ]);
      expect(server.row()).toMatchObject({ cfi: CFI_A, progression: 0.3, version: 2 });
    });

    it('acknowledges this save when the server replaced its time (a clock ahead)', async () => {
      const heard: ReadingSaved[] = [];
      const off = onReadingSaved((a) => heard.push(a));
      const echo = row({
        cfi: CFI_B,
        progression: 0.5,
        version: 4,
        updated_at: '2026-10-01T09:00:00.000Z',
      });
      await saveReadingPlace(
        fakeApi(async () => ({ reading_progress: echo })),
        save({ cfi: CFI_B, progression: 0.5, updated_at: '2026-10-01T10:00:00.000Z' }),
      );
      off();
      expect(heard[0].seen).toBe(true);
      expect((await at(CFI_B, 0.5)).base_version).toBe(4);
    });

    it('takes its own row echoed to a stale save as seen, its version left alone', async () => {
      await adoptServerPlace('c1', 1, 'A/Book', row({ version: 6 }));
      const heard: ReadingSaved[] = [];
      const off = onReadingSaved((a) => heard.push(a));
      // An answer that lands late, echoing this device's version 5.
      const echo = row({ cfi: CFI_B, progression: 0.5, version: 5 });
      await saveReadingPlace(
        fakeApi(async () => ({ reading_progress: echo })),
        save({ cfi: CFI_A, base_version: 6 }),
      );
      off();
      expect(heard[0].seen).toBe(true);
      expect(jumpOffer(heard[0], { cfi: CFI_A, progression: 0.2 })).toBeNull();
      expect((await at(CFI_A, 0.2)).base_version).toBe(6);
    });
  });

  it('forgets a removed connection’s places and queued saves', async () => {
    await saveReadingPlace(null, save({ connectionId: 'c1' }));
    await saveReadingPlace(null, save({ connectionId: 'c2' }));
    await removalCleanup('c1');
    expect((await readQueue()).map((s) => s.connectionId)).toEqual(['c2']);
    expect(Object.values(await readMirror())).toHaveLength(1);
    expect(mockClearEbookCache).toHaveBeenCalledWith('c1');
  });
});

describe('jumpOffer', () => {
  const kept = (p: Partial<ReadingProgress>, seen = false) => ({
    saved: { reading_progress: row({ device_id: 'phone', device_name: 'Pixel 8', ...p }) },
    seen,
  });

  it('offers the place another device kept when it is somewhere else', () => {
    expect(
      jumpOffer(kept({ cfi: CFI_B, progression: 0.6 }), { cfi: CFI_A, progression: 0.2 }),
    ).toEqual({ cfi: CFI_B, progression: 0.6, deviceName: 'Pixel 8' });
  });

  it('offers nothing when this device had seen the kept row', () => {
    expect(
      jumpOffer(kept({ cfi: CFI_B, progression: 0.6 }, true), { cfi: CFI_A, progression: 0.2 }),
    ).toBeNull();
  });

  it('offers nothing when the kept place is where the reader is', () => {
    expect(jumpOffer(kept({ cfi: CFI_A }), { cfi: CFI_A, progression: 0.2 })).toBeNull();
    expect(
      jumpOffer(kept({ cfi: CFI_B, progression: 0.205 }), { cfi: CFI_A, progression: 0.2 }),
    ).toBeNull();
  });

  it('names no device when the server has no name for it', () => {
    expect(
      jumpOffer(kept({ cfi: CFI_B, progression: 0.6, device_name: undefined }), {
        cfi: CFI_A,
        progression: 0.2,
      })?.deviceName,
    ).toBe('');
  });
});

function routeClients(map: Record<string, ApiClient | null>) {
  mockResolveClient.mockImplementation((cid: string) => map[cid] ?? null);
}
