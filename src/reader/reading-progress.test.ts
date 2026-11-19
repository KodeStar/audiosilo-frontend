import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { ApiError, type ApiClient, TimeoutError } from '@/api/client';
import { resolveClient, sessionReady } from '@/api/connection-clients';
import * as reachability from '@/api/reachability';
import type { ReadingProgress, ReadingProgressSaved } from '@/api/types';
import { CLAIM_MS } from '@/lib/queue-claims';
import { CONNECTIONS_KEY, READING_MIRROR_KEY, READING_QUEUE_KEY } from '@/lib/storage-keys';
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
const removalCleanups = (onConnectionRemoved as jest.Mock).mock.calls.map(
  ([cleanup]) => cleanup as (id: string) => Promise<void>,
);
const removalCleanup = removalCleanups.at(-1)!;

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

/** The tablet saves `progression` on `base`, now. */
const tabletSaves = (
  server: ReturnType<typeof ruleServer>,
  progression: number,
  base = 0,
): Promise<unknown> =>
  server.api.saveReadingProgress(1, 'A/Book', {
    cfi: CFI_C,
    progression,
    device_id: 'tablet',
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    base_version: base,
  });

async function stored<T>(key: string, fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(key);
  return raw ? (JSON.parse(raw) as T) : fallback;
}
const readQueue = () => stored<ReadingSave[]>(READING_QUEUE_KEY, []);
const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));
const readMirror = () =>
  stored<Record<string, { place: { cfi: string } | null; version: number }>>(
    READING_MIRROR_KEY,
    {},
  );

/** A fresh start: what this tab settled and a wait a 429 asked are the connections'
 * (`onConnectionRemoved`), and the tests reuse the same saves. */
async function forgetConnections() {
  for (const id of ['c1', 'c2']) for (const cleanup of removalCleanups) await cleanup(id);
  await AsyncStorage.clear();
}

/** `api` (a `fakeApi` by default) with its PUTs of `held` paths waiting until `release()`;
 * every other PUT answers as it did. */
function hangs(held: (path: string) => boolean, api: ReturnType<typeof fakeApi> = fakeApi()) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const answer = api.saveReadingProgress.getMockImplementation()!;
  api.saveReadingProgress.mockImplementation(
    async (lib: number, path: string, input: Record<string, unknown>) => {
      if (held(path)) await gate;
      return answer(lib, path, input);
    },
  );
  return { api, release };
}

/** A `hangs` predicate: the first PUT waits, the others do not. */
function firstOnly(): () => boolean {
  let first = true;
  return () => {
    const was = first;
    first = false;
    return was;
  };
}

/** `field` of every PUT `api` was asked, in order: of `path`'s only, when given. */
function sent<K extends keyof ReadingSave>(
  api: { saveReadingProgress: jest.Mock },
  field: K,
  path?: string,
): ReadingSave[K][] {
  return api.saveReadingProgress.mock.calls
    .filter(([, p]) => path === undefined || p === path)
    .map(([, , body]) => (body as ReadingSave)[field]);
}

describe('reading-progress', () => {
  beforeEach(async () => {
    await forgetConnections();
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

  it('captures a book’s pages a millisecond apart at least, and follows a clock set back', async () => {
    const at = Date.parse('2026-10-01T10:00:00.000Z');
    const now = jest.spyOn(Date, 'now').mockReturnValue(at);
    try {
      const capture = async (path = 'A/Book') =>
        (await captureReadingSave('c1', 1, path, { cfi: CFI_A, progression: 0.2 })).updated_at;
      expect(await capture()).toBe('2026-10-01T10:00:00.000Z');
      expect(await capture()).toBe('2026-10-01T10:00:00.001Z');
      // Another book's captures are its own.
      expect(await capture('B/Other')).toBe('2026-10-01T10:00:00.000Z');
      now.mockReturnValue(at - 500);
      expect(await capture()).toBe('2026-10-01T10:00:00.002Z');
      now.mockReturnValue(at - 5_000);
      expect(await capture()).toBe('2026-10-01T09:59:55.000Z');
    } finally {
      now.mockRestore();
    }
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
        unseen: null,
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
        ).resolves.toEqual({ place: null, fromServer: null, unseen: null });
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
      ).resolves.toEqual({ place: null, fromServer: null, unseen: null });
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
      ).resolves.toEqual({ place: null, fromServer: null, unseen: null });
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

    // Jump, or a reader already at the other place: the acknowledgement is not waited for,
    // and a save asked for right behind it read the version before it was written.
    it('makes a save asked for right after an acknowledgement on that version', async () => {
      const server = ruleServer('This phone');
      // This device read to 20% (version 1, acknowledged); the tablet then read on to 80%.
      await saveReaderPlace(server.api, 'c1', 1, 'A/Book', { cfi: CFI_A, progression: 0.2 });
      await server.api.saveReadingProgress(1, 'A/Book', {
        cfi: CFI_C,
        progression: 0.8,
        device_id: 'tablet',
        updated_at: new Date().toISOString(),
        base_version: 1,
      });
      const tablet = server.row()!;
      expect(tablet).toMatchObject({ progression: 0.8, version: 2 });
      // Shown here (Jump), then a page back at once: a move back on purpose, which applies.
      const adopted = adoptServerPlace('c1', 1, 'A/Book', tablet);
      await saveReaderPlace(server.api, 'c1', 1, 'A/Book', { cfi: CFI_B, progression: 0.5 });
      await adopted;
      expect(server.api.saveReadingProgress.mock.lastCall?.[2].base_version).toBe(2);
      expect(server.row()).toMatchObject({ cfi: CFI_B, progression: 0.5, version: 3 });
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

  describe('one queue for every send (fe#173)', () => {
    /** `server`'s api with its first PUT held until `release()`, counting the PUTs in flight. */
    function heldFirst(server: ReturnType<typeof ruleServer>) {
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      let inFlight = 0;
      let mostInFlight = 0;
      const api = {
        readingProgress: server.api.readingProgress,
        saveReadingProgress: jest.fn(async (lib: number, path: string, input: unknown) => {
          inFlight += 1;
          mostInFlight = Math.max(mostInFlight, inFlight);
          try {
            if (calls++ === 0) await gate;
            return await server.api.saveReadingProgress(lib, path, input);
          } finally {
            inFlight -= 1;
          }
        }),
      } as unknown as ApiClient & { saveReadingProgress: jest.Mock };
      return { api, release, mostInFlight: () => mostInFlight };
    }

    it('sends a page captured on 0 before a Jump on 0, never on the place jumped to', async () => {
      const server = ruleServer('Tablet');
      await tabletSaves(server, 0.8);
      const tablet = server.row()!;
      const held = heldFirst(server);
      const heard: ReadingSaved[] = [];
      const off = onReadingSaved((a) => heard.push(a));
      // This device never saw the tablet's place: its first page is answered late.
      const first = saveReaderPlace(held.api, 'c1', 1, 'A/Book', { cfi: CFI_A, progression: 0.1 });
      // A second page, captured on 0 while the first is out.
      const second = saveReaderPlace(held.api, 'c1', 1, 'A/Book', {
        cfi: CFI_B,
        progression: 0.12,
      });
      await nextMacrotask();
      // Jump: the tablet's place is shown here before the second page is sent.
      await adoptServerPlace('c1', 1, 'A/Book', tablet);
      held.release();
      await Promise.all([first, second]);
      off();
      expect(held.api.saveReadingProgress.mock.calls.map(([, , b]) => b.base_version)).toEqual([
        0, 0,
      ]);
      // The tablet's place stands; both answers are the row Jump showed (seen: no offer again).
      expect(server.row()).toMatchObject({ progression: 0.8, version: tablet.version });
      expect(heard.map((a) => a.seen)).toEqual([true, true]);
      // A page after the Jump is made on its version, and applies.
      await saveReaderPlace(held.api, 'c1', 1, 'A/Book', { cfi: CFI_C, progression: 0.81 });
      expect(server.row()).toMatchObject({ progression: 0.81, version: tablet.version + 1 });
    });

    it('still makes a page captured on 0 on the version its own earlier page was answered with', async () => {
      const server = ruleServer('This phone');
      const held = heldFirst(server);
      const first = saveReaderPlace(held.api, 'c1', 1, 'A/Book', { cfi: CFI_B, progression: 0.5 });
      const back = saveReaderPlace(held.api, 'c1', 1, 'A/Book', { cfi: CFI_A, progression: 0.3 });
      await nextMacrotask();
      held.release();
      await Promise.all([first, back]);
      expect(held.api.saveReadingProgress.mock.calls.map(([, , b]) => b.base_version)).toEqual([
        0, 1,
      ]);
      expect(server.row()).toMatchObject({ progression: 0.3, version: 2 });
    });

    it('sends the reader’s page after a replay in flight, so a move back applies', async () => {
      const server = ruleServer('This phone');
      // Read to 60% offline: queued on 0.
      reachable.mockReturnValue(false);
      await saveReaderPlace(null, 'c1', 1, 'A/Book', { cfi: CFI_C, progression: 0.6 });
      expect(await readQueue()).toHaveLength(1);
      reachable.mockReturnValue(true);
      const held = heldFirst(server);
      mockResolveClient.mockReturnValue(held.api);
      // The reader opens (its replay goes out), and the listener pages back at once.
      const replay = flushReadingQueue();
      await nextMacrotask();
      const back = saveReaderPlace(held.api, 'c1', 1, 'A/Book', { cfi: CFI_A, progression: 0.3 });
      await nextMacrotask();
      held.release();
      await Promise.all([replay, back]);
      expect(held.mostInFlight()).toBe(1);
      expect(held.api.saveReadingProgress.mock.calls.map(([, , b]) => b.progression)).toEqual([
        0.6, 0.3,
      ]);
      expect(server.row()).toMatchObject({ progression: 0.3, version: 2 });
    });

    it('never replays a queued save after a newer save of the book was sent', async () => {
      const server = ruleServer('This phone');
      mockResolveClient.mockReturnValue(server.api);
      reachable.mockReturnValue(false);
      await saveReadingPlace(
        null,
        save({ cfi: CFI_C, progression: 0.6, updated_at: '2026-10-01T10:00:00.000Z' }),
      );
      // Another book's queued save stays.
      await saveReadingPlace(
        null,
        save({ path: 'B/Other', updated_at: '2026-10-01T10:00:00.000Z' }),
      );
      reachable.mockReturnValue(true);
      await saveReadingPlace(
        server.api,
        save({ cfi: CFI_A, progression: 0.3, updated_at: '2026-10-01T11:00:00.000Z' }),
      );
      await flushReadingQueue();
      const sent = server.api.saveReadingProgress.mock.calls.filter(
        ([, path]) => path === 'A/Book',
      );
      expect(sent.map(([, , b]) => b.progression)).toEqual([0.3]);
      expect(server.api.saveReadingProgress.mock.calls.map(([, path]) => path)).toContain(
        'B/Other',
      );
      expect(await readQueue()).toEqual([]);
    });
  });

  describe('a request that hangs (fe#173)', () => {
    const progressions = (api: { saveReadingProgress: jest.Mock }, path = 'A/Book') =>
      sent(api, 'progression', path);

    it('never holds another book’s save, or another server’s, behind it', async () => {
      const one = hangs((path) => path === 'A/Book');
      const hung = saveReadingPlace(one.api, save());
      await nextMacrotask();
      await expect(saveReadingPlace(one.api, save({ path: 'B/Other' }))).resolves.not.toBeNull();
      const two = fakeApi();
      await expect(saveReadingPlace(two, save({ connectionId: 'c2' }))).resolves.not.toBeNull();
      one.release();
      await hung;
    });

    it('sends only the latest of the saves of its book held behind it', async () => {
      const { api, release } = hangs(() => true);
      const first = saveReadingPlace(api, save({ progression: 0.1 }));
      await nextMacrotask();
      const later = [0.2, 0.3, 0.4].map((progression, i) =>
        saveReadingPlace(api, save({ progression, updated_at: `2026-10-01T10:0${i + 1}:00.000Z` })),
      );
      release();
      await Promise.all([first, ...later]);
      expect(progressions(api)).toEqual([0.1, 0.4]);
    });

    it('never holds the reader’s save of a book behind a replay’s hung save of another', async () => {
      reachable.mockReturnValue(false);
      await saveReadingPlace(null, save({ path: 'B/Other' }));
      await saveReadingPlace(null, save({ progression: 0.6 }));
      reachable.mockReturnValue(true);
      const { api, release } = hangs((path) => path === 'B/Other');
      routeClients({ c1: api });
      const replay = flushReadingQueue();
      await nextMacrotask();
      // The replay holds B/Other; the reader pages back in A/Book meanwhile, and it goes.
      await expect(
        saveReadingPlace(
          api,
          save({ cfi: CFI_B, progression: 0.3, updated_at: '2026-10-01T11:00:00.000Z' }),
        ),
      ).resolves.not.toBeNull();
      release();
      await replay;
      // The replay's older A/Book save was overtaken: never sent after it.
      expect(progressions(api)).toEqual([0.3]);
      expect(await readQueue()).toEqual([]);
    });

    it('queues a save as it starts to wait behind one of its book, and sends it once in its turn', async () => {
      const { api, release } = hangs(() => true);
      const first = saveReadingPlace(api, save({ progression: 0.5 }));
      await nextMacrotask();
      const queuedFirst = await readQueue();
      const waiting = saveReadingPlace(
        api,
        save({ cfi: CFI_B, progression: 0.3, updated_at: '2026-10-01T10:05:00.000Z' }),
      );
      await nextMacrotask();
      // Closed now, the replay sends the page it waited with, not only the older one.
      const queuedWaiting = (await readQueue()).map((s) => s.progression);
      // Released before any expectation: a failing one never leaves the book's turn held.
      release();
      await Promise.all([first, waiting]);
      expect(queuedFirst).toEqual([]);
      expect(queuedWaiting).toEqual([0.3]);
      expect(progressions(api)).toEqual([0.5, 0.3]);
      expect(await readQueue()).toEqual([]);
    });

    it('a waiting save a replay claimed goes once, on the version the one before it acknowledged', async () => {
      const server = ruleServer('This browser');
      const { release } = hangs(firstOnly(), server.api);
      routeClients({ c1: server.api });
      // Both made on 0; the reader moved back while the first hung.
      const first = saveReadingPlace(server.api, save({ progression: 0.5 }));
      await nextMacrotask();
      const waiting = saveReadingPlace(
        server.api,
        save({ cfi: CFI_B, progression: 0.3, updated_at: '2026-10-01T10:05:00.000Z' }),
      );
      await nextMacrotask();
      // A sign-out's last flush claims the waiting save and waits for its turn: its own turn
      // sends it, and the replay finds it settled.
      const replay = flushReadingConnection('c1');
      await nextMacrotask();
      release();
      await Promise.all([first, waiting, replay]);
      expect(progressions(server.api)).toEqual([0.5, 0.3]);
      expect(server.api.saveReadingProgress.mock.calls[1][2]).toMatchObject({ base_version: 1 });
      // Sent on 0 it diverged, and the server kept the further page.
      expect(server.row()).toMatchObject({ cfi: CFI_B, progression: 0.3 });
      expect(await readQueue()).toEqual([]);
    });

    it('a waiting save this tab’s replay claimed goes in its own turn, not behind another book', async () => {
      // Another book's place queued before: the replay claims it first, and its request hangs
      // until it times out (no answer: it stops the replay).
      await AsyncStorage.setItem(
        READING_QUEUE_KEY,
        JSON.stringify([save({ path: 'B/Other', updated_at: '2026-10-01T09:00:00.000Z' })]),
      );
      let timeOut = () => {};
      const timedOut = new Promise<void>((resolve) => (timeOut = resolve));
      const server = fakeApi();
      const answer = server.saveReadingProgress.getMockImplementation()!;
      server.saveReadingProgress.mockImplementation(
        async (lib: number, path: string, input: Record<string, unknown>) => {
          if (path !== 'B/Other') return answer(lib, path, input);
          await timedOut;
          throw new TimeoutError(15_000);
        },
      );
      const { api, release } = hangs(firstOnly(), server);
      routeClients({ c1: api });
      const first = saveReadingPlace(api, save({ cfi: CFI_A, progression: 0.5 }));
      await nextMacrotask();
      const waiting = saveReadingPlace(
        api,
        save({ cfi: CFI_B, progression: 0.6, updated_at: '2026-10-01T10:05:00.000Z' }),
      );
      await nextMacrotask();
      // The window focused while the first hung: this tab's replay claims both queued saves.
      const replay = flushReadingQueue();
      await nextMacrotask();
      release();
      await Promise.all([first, waiting]);
      const sentBeforeTimeout = sent(api, 'cfi', 'A/Book');
      timeOut();
      await replay;
      // The replays the two answers asked for, done too.
      await flushReadingQueue();
      expect(sentBeforeTimeout).toEqual([CFI_A, CFI_B]);
      expect(sent(api, 'cfi', 'A/Book')).toEqual([CFI_A, CFI_B]);
      expect((await readQueue()).map((s) => s.path)).toEqual(['B/Other']);
    });

    it('replays a save made on 0 on the version its own save acknowledged since', async () => {
      const api = fakeApi();
      routeClients({ c1: api });
      await saveReadingPlace(api, save({ progression: 0.5 }));
      // Queued as it waited behind that save, then the app closed before its turn.
      await AsyncStorage.setItem(
        READING_QUEUE_KEY,
        JSON.stringify([
          save({ cfi: CFI_B, progression: 0.3, updated_at: '2026-10-01T10:05:00.000Z' }),
        ]),
      );
      await flushReadingQueue();
      expect(sent(api, 'cfi')).toEqual([CFI_A, CFI_B]);
      expect(sent(api, 'base_version')).toEqual([0, 5]);
    });

    it('a replay asked while one is out waits for it (a sign-out’s last flush)', async () => {
      reachable.mockReturnValue(false);
      await saveReadingPlace(null, save());
      reachable.mockReturnValue(true);
      const { api, release } = hangs(() => true);
      routeClients({ c1: api });
      const replay = flushReadingQueue();
      await nextMacrotask();
      let done = false;
      const last = flushReadingConnection('c1').then(() => (done = true));
      await nextMacrotask();
      expect(done).toBe(false);
      release();
      await Promise.all([replay, last]);
      expect(done).toBe(true);
    });
  });

  describe('the queue, newest first (fe#173)', () => {
    it('keeps the newer queued save of a book when an older one fails after it', async () => {
      await saveReadingPlace(null, save({ cfi: CFI_B, updated_at: '2026-10-01T10:05:00.000Z' }));
      await saveReadingPlace(
        fakeApi(() => Promise.reject(new TypeError('offline'))),
        save({ cfi: CFI_A }),
      );
      expect((await readQueue()).map((s) => s.cfi)).toEqual([CFI_B]);
    });

    it('puts a save in place of an older queued one before it is sent', async () => {
      await saveReadingPlace(null, save({ cfi: CFI_A }));
      // The request is still out (the app could close under it).
      let answer = () => {};
      const answered = new Promise<void>((resolve) => (answer = resolve));
      const api = fakeApi(async (input) => {
        await answered;
        return { reading_progress: row({ ...(input as Partial<ReadingProgress>), version: 5 }) };
      });
      const sent = saveReadingPlace(
        api,
        save({ cfi: CFI_B, updated_at: '2026-10-01T10:05:00.000Z' }),
      );
      await nextMacrotask();
      expect(api.saveReadingProgress).toHaveBeenCalled();
      expect((await readQueue()).map((s) => s.cfi)).toEqual([CFI_B]);
      answer();
      await sent;
      expect(await readQueue()).toEqual([]);
    });

    it('drops an older queued save of a book when a newer one is refused for good', async () => {
      await saveReadingPlace(null, save({ cfi: CFI_A }));
      await saveReadingPlace(
        fakeApi(() => Promise.reject(new ApiError(403, 'forbidden'))),
        save({ cfi: CFI_B, updated_at: '2026-10-01T10:05:00.000Z' }),
      );
      expect(await readQueue()).toEqual([]);
      const api = fakeApi();
      routeClients({ c1: api });
      await flushReadingQueue();
      expect(api.saveReadingProgress).not.toHaveBeenCalled();
    });
  });

  it('stops a replay at a 429 and queues every save until its Retry-After is over', async () => {
    reachable.mockReturnValue(false);
    await saveReadingPlace(null, save({ path: 'B/Other' }));
    await saveReadingPlace(null, save());
    reachable.mockReturnValue(true);
    let limited = true;
    const api = fakeApi(async (input) => {
      if (limited) throw new ApiError(429, 'slow down', undefined, 60);
      return { reading_progress: row({ ...(input as Partial<ReadingProgress>), version: 5 }) };
    });
    routeClients({ c1: api });
    const now = jest.spyOn(Date, 'now');
    try {
      await flushReadingQueue();
      expect(api.saveReadingProgress).toHaveBeenCalledTimes(1);
      expect(await readQueue()).toHaveLength(2);
      // Within the wait: the reader's save is queued, no request.
      limited = false;
      await expect(
        saveReadingPlace(api, save({ cfi: CFI_B, updated_at: '2026-10-01T10:05:00.000Z' })),
      ).resolves.toBeNull();
      await flushReadingQueue();
      expect(api.saveReadingProgress).toHaveBeenCalledTimes(1);
      // The wait is over: the newest place of each book goes.
      now.mockReturnValue(Date.now() + 61_000);
      await flushReadingQueue();
      expect(api.saveReadingProgress.mock.calls.map(([, path, body]) => [path, body.cfi])).toEqual(
        expect.arrayContaining([
          ['B/Other', CFI_A],
          ['A/Book', CFI_B],
        ]),
      );
      expect(await readQueue()).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  describe('a 429 is the connection’s (fe#173)', () => {
    const limitedApi = (retryAfter?: number) =>
      fakeApi(() => Promise.reject(new ApiError(429, 'slow down', undefined, retryAfter)));

    it('holds whatever client a replay is built, and a sign-out’s last flush still tries', async () => {
      await saveReadingPlace(limitedApi(60), save());
      // `resolveClient` builds a client per call: the replay's is another one.
      const next = fakeApi();
      routeClients({ c1: next });
      await flushReadingQueue();
      expect(next.saveReadingProgress).not.toHaveBeenCalled();
      expect(await readQueue()).toHaveLength(1);
      // Signing out (`teardownBeforeTokenRevoke`): the queued place's last chance.
      await flushReadingConnection('c1');
      expect(next.saveReadingProgress).toHaveBeenCalledTimes(1);
      expect(await readQueue()).toEqual([]);
    });

    it('replays the places it held once the wait is over, with nothing else to send them', async () => {
      await saveReadingPlace(limitedApi(1), save());
      const next = fakeApi();
      routeClients({ c1: next });
      for (let i = 0; i < 60 && (await readQueue()).length > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(next.saveReadingProgress).toHaveBeenCalledTimes(1);
      expect(await readQueue()).toEqual([]);
    });
  });

  it('never sends a claimed save after a newer one of its book took its place in the queue', async () => {
    reachable.mockReturnValue(false);
    await saveReadingPlace(null, save({ path: 'B/Other' }));
    await saveReadingPlace(null, save({ progression: 0.6 }));
    reachable.mockReturnValue(true);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const api = fakeApi();
    const answer = api.saveReadingProgress.getMockImplementation()!;
    api.saveReadingProgress.mockImplementation(
      async (lib: number, path: string, input: Record<string, unknown>) => {
        if (path === 'B/Other') await gate;
        return answer(lib, path, input);
      },
    );
    routeClients({ c1: api });
    const replay = flushReadingQueue();
    await nextMacrotask();
    // The replay holds B/Other with A/Book claimed; the reader pages back in A/Book, and that
    // save fails: it is queued in place of the claimed one.
    await saveReadingPlace(
      fakeApi(() => Promise.reject(new TypeError('offline'))),
      save({ cfi: CFI_B, progression: 0.3, updated_at: '2026-10-01T11:00:00.000Z' }),
    );
    release();
    await replay;
    expect(api.saveReadingProgress.mock.calls.filter(([, path]) => path === 'A/Book')).toEqual([]);
    expect((await readQueue()).map((s) => [s.path, s.cfi])).toEqual([['A/Book', CFI_B]]);
  });

  it('never sends a claimed save another tab has dropped for a newer one it sent', async () => {
    reachable.mockReturnValue(false);
    await saveReadingPlace(null, save({ path: 'B/Other' }));
    await saveReadingPlace(null, save({ progression: 0.6 }));
    reachable.mockReturnValue(true);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const api = fakeApi();
    const answer = api.saveReadingProgress.getMockImplementation()!;
    api.saveReadingProgress.mockImplementation(
      async (lib: number, path: string, input: Record<string, unknown>) => {
        if (path === 'B/Other') await gate;
        return answer(lib, path, input);
      },
    );
    routeClients({ c1: api });
    const replay = flushReadingQueue();
    await nextMacrotask();
    // The replay holds B/Other with A/Book claimed; another tab's reader pages back in
    // A/Book, and that save is sent: the claimed one leaves the stored queue, with nothing
    // newer queued in its place and nothing this tab knows of settled.
    const queue = await readQueue();
    await AsyncStorage.setItem(
      READING_QUEUE_KEY,
      JSON.stringify(queue.filter((s) => s.path !== 'A/Book')),
    );
    release();
    await replay;
    expect(api.saveReadingProgress.mock.calls.filter(([, path]) => path === 'A/Book')).toEqual([]);
    expect(await readQueue()).toEqual([]);
  });

  describe('the place after a replay (fe#173)', () => {
    it('opens at the newer local place with the row it never saw, to offer Jump at once', async () => {
      const server = ruleServer('Tablet');
      mockResolveClient.mockReturnValue(server.api);
      await tabletSaves(server, 0.8);
      // An offline session on 0, replayed from Home: the server keeps the tablet's place.
      reachable.mockReturnValue(false);
      await saveReadingPlace(
        null,
        save({ cfi: CFI_A, progression: 0.3, updated_at: new Date().toISOString() }),
      );
      reachable.mockReturnValue(true);
      await flushReadingQueue();
      expect(server.row()).toMatchObject({ device_id: 'tablet', progression: 0.8 });
      const found = await lookupReadingPlace(server.api, 'c1', 1, 'A/Book');
      expect(found).toEqual({
        place: expect.objectContaining({ cfi: CFI_A }),
        fromServer: null,
        unseen: server.row(),
      });
      // Shown (Stay): seen, so nothing is offered again.
      await adoptServerPlace('c1', 1, 'A/Book', server.row()!);
      expect((await lookupReadingPlace(server.api, 'c1', 1, 'A/Book')).unseen).toBeNull();
    });

    it('offers the row a replay in flight leaves, once its answer is in (the gate waits for it)', async () => {
      const server = ruleServer('Tablet');
      await tabletSaves(server, 0.8);
      reachable.mockReturnValue(false);
      await saveReadingPlace(
        null,
        save({ cfi: CFI_A, progression: 0.3, updated_at: new Date().toISOString() }),
      );
      reachable.mockReturnValue(true);
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const put = server.api.saveReadingProgress.getMockImplementation()!;
      server.api.saveReadingProgress.mockImplementation(async (...args: unknown[]) => {
        await gate;
        return put(...args);
      });
      mockResolveClient.mockReturnValue(server.api);
      // The replay is out (its answer will keep the tablet's place) as the lookup asks.
      const replay = flushReadingQueue();
      await nextMacrotask();
      const lookup = lookupReadingPlace(server.api, 'c1', 1, 'A/Book');
      await nextMacrotask();
      release();
      const [found] = await Promise.all([lookup, replay]);
      expect(found.place?.cfi).toBe(CFI_A);
      expect(found.unseen).toMatchObject({ device_id: 'tablet', progression: 0.8 });
    });

    it('opens at its own place the server kept, not the row read before a replay in flight was answered', async () => {
      const server = ruleServer('Tablet');
      await tabletSaves(server, 0.3);
      // An offline session further on, made before the tablet's save by the clock.
      reachable.mockReturnValue(false);
      await saveReadingPlace(
        null,
        save({
          cfi: CFI_A,
          progression: 0.6,
          updated_at: new Date(Date.now() - 120_000).toISOString(),
        }),
      );
      reachable.mockReturnValue(true);
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const put = server.api.saveReadingProgress.getMockImplementation()!;
      server.api.saveReadingProgress.mockImplementation(async (...args: unknown[]) => {
        await gate;
        return put(...args);
      });
      mockResolveClient.mockReturnValue(server.api);
      // The lookup reads the tablet's row; the replay's answer then keeps this device's place.
      const replay = flushReadingQueue();
      await nextMacrotask();
      const lookup = lookupReadingPlace(server.api, 'c1', 1, 'A/Book');
      await nextMacrotask();
      release();
      const [found] = await Promise.all([lookup, replay]);
      expect(server.row()).toMatchObject({ device_id: 'dev', progression: 0.6 });
      expect(found).toEqual({
        place: expect.objectContaining({ cfi: CFI_A }),
        fromServer: null,
        unseen: null,
      });
    });

    it('offers no row older than the version this device acknowledged (an answer overtaken)', async () => {
      await adoptServerPlace(
        'c1',
        1,
        'A/Book',
        row({
          device_id: 'phone',
          version: 9,
          progression: 0.2,
          updated_at: new Date().toISOString(),
        }),
      );
      const stale = row({ device_id: 'tablet', version: 5, progression: 0.8 });
      const found = await lookupReadingPlace(
        fakeApi(undefined, async () => stale),
        'c1',
        1,
        'A/Book',
      );
      expect(found.fromServer).toBeNull();
      expect(found.unseen).toBeNull();
    });

    it('offers no row behind the place it opens at: the next save keeps the further', async () => {
      const server = ruleServer('Tablet');
      await tabletSaves(server, 0.3);
      // This device's newer place further on stayed here (its save refused).
      await saveReadingPlace(
        fakeApi(() => Promise.reject(new ApiError(403, 'forbidden'))),
        save({ cfi: CFI_B, progression: 0.6, updated_at: new Date().toISOString() }),
      );
      const found = await lookupReadingPlace(server.api, 'c1', 1, 'A/Book');
      expect(found).toEqual({
        place: expect.objectContaining({ cfi: CFI_B }),
        fromServer: null,
        unseen: null,
      });
    });

    it('offers no row from the lookup while a save of the book is queued (its replay answers)', async () => {
      const server = ruleServer('Tablet');
      await tabletSaves(server, 0.8);
      reachable.mockReturnValue(false);
      await saveReadingPlace(
        null,
        save({ cfi: CFI_A, progression: 0.3, updated_at: new Date().toISOString() }),
      );
      reachable.mockReturnValue(true);
      const found = await lookupReadingPlace(server.api, 'c1', 1, 'A/Book');
      expect(found.place?.cfi).toBe(CFI_A);
      expect(found.unseen).toBeNull();
    });

    it('offers no row from the lookup that is this device’s own, at a version it acknowledged', async () => {
      const server = ruleServer('This phone');
      await saveReaderPlace(server.api, 'c1', 1, 'A/Book', { cfi: CFI_A, progression: 0.3 });
      // A newer local place not yet sent (the mirror only).
      await captureReadingSave('c1', 1, 'A/Book', { cfi: CFI_B, progression: 0.31 }).then((s) =>
        saveReadingPlace(null, { ...s, updated_at: new Date(Date.now() + 60_000).toISOString() }),
      );
      await flushReadingQueue();
      const found = await lookupReadingPlace(server.api, 'c1', 1, 'A/Book');
      expect(found.fromServer).toBeNull();
      expect(found.unseen).toBeNull();
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

// The web player's tabs share the reader's mirror and queue. A lock per tab let one tab
// write its read of either over another tab's change made meanwhile.
describe('reading places across tabs', () => {
  const nav = globalThis.navigator as { locks?: unknown };

  beforeEach(async () => {
    await forgetConnections();
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
    let other!: typeof import('./reading-progress');
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
      other = require('./reading-progress') as typeof import('./reading-progress');
    });
    return other;
  };

  it("never writes over the other tab's place or queued save", async () => {
    const other = otherTab();
    await Promise.all([
      saveReadingPlace(null, save({ path: 'A/Book' })),
      other.saveReadingPlace(null, save({ path: 'B/Other' })),
    ]);
    expect(Object.keys(await readMirror()).sort()).toEqual(['c1:1:A/Book', 'c1:1:B/Other']);
    expect((await readQueue()).map((s) => s.path).sort()).toEqual(['A/Book', 'B/Other']);
  });

  it("keeps a save another tab queued while this tab's replay was out, and sends nothing twice", async () => {
    await AsyncStorage.setItem(READING_QUEUE_KEY, JSON.stringify([save()]));
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const api = fakeApi(async (input) => {
      await answered;
      return { reading_progress: row({ ...(input as Partial<ReadingProgress>), version: 5 }) };
    });
    routeClients({ c1: api });
    const replaying = flushReadingQueue();
    await new Promise((r) => setTimeout(r, 0));
    const other = otherTab();
    // The other tab's replay leaves the save this tab is sending alone.
    await other.flushReadingQueue();
    expect(api.saveReadingProgress).toHaveBeenCalledTimes(1);
    // And its save queued meanwhile stays queued.
    await other.saveReadingPlace(null, save({ path: 'B/Other' }));
    answer();
    await replaying;
    expect((await readQueue()).map((s) => s.path)).toEqual(['B/Other']);
  });

  const cfisSent = (api: { saveReadingProgress: jest.Mock }) => sent(api, 'cfi');

  // A save waiting behind a hung one of its book lived only in memory and the mirror: the
  // app killed there, the server kept the previous page until the next save of the book.
  it('replays a save that was waiting behind a hung one when the app was killed, once', async () => {
    const { api, release } = hangs(firstOnly());
    const first = saveReadingPlace(api, save({ cfi: CFI_A, progression: 0.5 }));
    await nextMacrotask();
    const waiting = saveReadingPlace(
      api,
      save({ cfi: CFI_B, progression: 0.6, updated_at: '2026-10-01T10:05:00.000Z' }),
    );
    await nextMacrotask();
    // Killed here: a fresh start of the app replays the stored queue.
    const restarted = otherTab();
    const after = fakeApi();
    routeClients({ c1: after });
    await restarted.flushReadingQueue();
    await restarted.flushReadingQueue();
    const queuedAfterRestart = await readQueue();
    // Let the old module's requests settle (in a killed app they never did): the waiting save
    // left the queue, so it is not sent from there again.
    release();
    await Promise.all([first, waiting]);
    expect(cfisSent(after)).toEqual([CFI_B]);
    expect(queuedAfterRestart).toEqual([]);
    expect(cfisSent(api)).toEqual([CFI_A]);
  });

  // The session of a tab holds the connections it loaded: one signed in to in another tab
  // since is stored, not in it. Its replay dropped that connection's saves as gone, a live
  // one waiting behind its own tab's hung save included, which was then never sent.
  it('drops a save whose connection is gone from every tab', async () => {
    await AsyncStorage.setItem(CONNECTIONS_KEY, JSON.stringify([{ id: 'c2' }]));
    await AsyncStorage.setItem(READING_QUEUE_KEY, JSON.stringify([save()]));
    routeClients({});
    await flushReadingQueue();
    expect(await readQueue()).toEqual([]);
  });

  it('drops a save of a connection the app does not know off the web, though it is stored', async () => {
    await AsyncStorage.setItem(CONNECTIONS_KEY, JSON.stringify([{ id: 'c1' }]));
    await AsyncStorage.setItem(READING_QUEUE_KEY, JSON.stringify([save()]));
    routeClients({});
    await flushReadingQueue();
    expect(await readQueue()).toEqual([]);
  });

  // The web player: a save waiting for its turn claims its queued copy for its own tab.
  describe('on the web', () => {
    let os: typeof Platform.OS;
    beforeEach(() => {
      os = Platform.OS;
      Platform.OS = 'web';
    });
    afterEach(() => {
      Platform.OS = os;
    });

    it('leaves a save of a connection this tab does not know to the tab signed in to it', async () => {
      await AsyncStorage.setItem(CONNECTIONS_KEY, JSON.stringify([{ id: 'c1' }]));
      const other = otherTab();
      const { api, release } = hangs(firstOnly());
      const first = other.saveReadingPlace(api, save({ cfi: CFI_A, progression: 0.5 }));
      await nextMacrotask();
      const waiting = other.saveReadingPlace(
        api,
        save({ cfi: CFI_B, progression: 0.6, updated_at: '2026-10-01T10:05:00.000Z' }),
      );
      await nextMacrotask();
      routeClients({});
      await flushReadingQueue();
      const queuedHere = (await readQueue()).map((s) => s.cfi);
      release();
      await Promise.all([first, waiting]);
      expect(queuedHere).toEqual([CFI_B]);
      expect(cfisSent(api)).toEqual([CFI_A, CFI_B]);
      expect(await readQueue()).toEqual([]);
    });

    // Another tab's replay sent the waiting copy while its own tab's earlier save of the book
    // was still out: both on 0, the server took them as diverged and kept the further place.
    it('never lets another tab send a save while its tab still has the book’s earlier one out', async () => {
      const server = ruleServer('This browser');
      const { api, release } = hangs(firstOnly(), server.api);
      routeClients({ c1: api });
      const first = saveReadingPlace(api, save({ cfi: CFI_B, progression: 0.5 }));
      await nextMacrotask();
      // The reader moved back while the first hung.
      const back = saveReadingPlace(
        api,
        save({ cfi: CFI_A, progression: 0.3, updated_at: '2026-10-01T10:05:00.000Z' }),
      );
      await nextMacrotask();
      await otherTab().flushReadingQueue();
      const sentMeanwhile = cfisSent(api);
      release();
      await Promise.all([first, back]);
      // The move back applied: sent on the first's version once it was answered.
      expect(server.row()).toMatchObject({ cfi: CFI_A, progression: 0.3, version: 2 });
      expect(sentMeanwhile).toEqual([CFI_B]);
      expect(sent(api, 'base_version')).toEqual([0, 1]);
      expect(await readQueue()).toEqual([]);
    });

    // The wait's claim kept this tab's own replay off the copy too: a sign-out's last flush
    // was over at once, and the token was revoked under the waiting save.
    it('sends a waiting save before a sign-out’s last flush is over', async () => {
      const { api, release } = hangs(firstOnly());
      routeClients({ c1: api });
      const first = saveReadingPlace(api, save({ cfi: CFI_A, progression: 0.5 }));
      await nextMacrotask();
      const waiting = saveReadingPlace(
        api,
        save({ cfi: CFI_B, progression: 0.6, updated_at: '2026-10-01T10:05:00.000Z' }),
      );
      await nextMacrotask();
      let done = false;
      const last = flushReadingConnection('c1').then(() => (done = true));
      await nextMacrotask();
      const doneEarly = done;
      release();
      await last;
      expect(doneEarly).toBe(false);
      expect(cfisSent(api)).toEqual([CFI_A, CFI_B]);
      await Promise.all([first, waiting]);
      expect(await readQueue()).toEqual([]);
    });

    // The hung save failed and marked the server down: the waiting one's turn queued it, and
    // the last flush, replaying before that turn, left it to be purged with the connection.
    it('sends a waiting save its turn queued before a sign-out’s last flush is over', async () => {
      const { api, release } = hangs(firstOnly());
      const answer = api.saveReadingProgress.getMockImplementation()!;
      let calls = 0;
      api.saveReadingProgress.mockImplementation(async (...args: Parameters<typeof answer>) => {
        calls += 1;
        const result = await answer(...args);
        if (calls === 1) {
          reachable.mockReturnValue(false);
          throw new TypeError('offline');
        }
        return result;
      });
      routeClients({ c1: api });
      const first = saveReadingPlace(api, save({ cfi: CFI_A, progression: 0.5 }));
      await nextMacrotask();
      const waiting = saveReadingPlace(
        api,
        save({ cfi: CFI_B, progression: 0.6, updated_at: '2026-10-01T10:05:00.000Z' }),
      );
      await nextMacrotask();
      const last = flushReadingConnection('c1');
      await nextMacrotask();
      release();
      await Promise.all([first, waiting, last]);
      expect(cfisSent(api)).toEqual([CFI_A, CFI_B]);
      expect(await readQueue()).toEqual([]);
    });

    it('sends a waiting save once when another tab replays it after its claim ran out', async () => {
      const { api, release } = hangs(firstOnly());
      routeClients({ c1: api });
      const first = saveReadingPlace(api, save({ cfi: CFI_A, progression: 0.5 }));
      await nextMacrotask();
      const waiting = saveReadingPlace(
        api,
        save({ cfi: CFI_B, progression: 0.6, updated_at: '2026-10-01T10:05:00.000Z' }),
      );
      await nextMacrotask();
      // Still waiting once the claim ran out: the other tab claims it, then this tab's turn
      // comes while its request is still out.
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now + CLAIM_MS + 1);
      try {
        let answer = () => {};
        const answered = new Promise<void>((resolve) => (answer = resolve));
        const otherApi = fakeApi(async (input) => {
          await answered;
          return { reading_progress: row({ ...(input as Partial<ReadingProgress>), version: 5 }) };
        });
        routeClients({ c1: otherApi });
        const replaying = otherTab().flushReadingQueue();
        await nextMacrotask();
        const claimedElsewhere = cfisSent(otherApi);
        release();
        await Promise.all([first, waiting]);
        answer();
        await replaying;
        expect(claimedElsewhere).toEqual([CFI_B]);
        expect(cfisSent(api)).toEqual([CFI_A]);
        expect(cfisSent(otherApi)).toEqual([CFI_B]);
        expect(await readQueue()).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    });
  });

  // Storage full: the drop of the older queued place after a newer one was sent is refused,
  // and the replay that followed sent the older place over the newer.
  it('never replays an older place after a newer one, when storage refuses to drop it', async () => {
    const older = save({ cfi: CFI_A, updated_at: '2026-01-01T00:00:00Z' });
    await AsyncStorage.setItem(READING_QUEUE_KEY, JSON.stringify([older]));
    const sent: string[] = [];
    const api = fakeApi(async (input) => {
      const place = input as Partial<ReadingProgress>;
      sent.push(place.cfi ?? '');
      return { reading_progress: row({ ...place, version: 5 }) };
    });
    routeClients({ c1: api });
    const setItem = AsyncStorage.setItem as jest.Mock;
    const write = setItem.getMockImplementation()!;
    setItem.mockImplementation(async (key: string, value: string) => {
      if (key === READING_QUEUE_KEY) throw new Error('quota');
      return write(key, value);
    });
    try {
      await saveReadingPlace(api, save({ cfi: CFI_B, updated_at: '2026-01-02T00:00:00Z' }));
      await flushReadingQueue();
      expect(sent).toEqual([CFI_B]);
      expect(await readQueue()).toHaveLength(1);
    } finally {
      setItem.mockImplementation(write);
    }
    // Storage takes writes again: the older place leaves the queue, unsent.
    await flushReadingQueue();
    expect(sent).toEqual([CFI_B]);
    expect(await readQueue()).toEqual([]);
  });
});
