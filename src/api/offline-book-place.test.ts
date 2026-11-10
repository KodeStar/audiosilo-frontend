import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ApiClient } from '@/api/client';
import type { Progress } from '@/api/types';

// v2.5.1 PLAYER-01, end to end through the real progress mirror: a book downloaded while
// its server had it at 70% opens there offline (the book page's read and the player's
// resume lookup), and its first offline save starts from there instead of from 0, which
// the server's last-write-wins rule would have taken over the real place.

jest.mock('@/api/reachability', () => ({
  isReachable: jest.fn(() => false),
  noteFailure: jest.fn(),
  noteSuccess: jest.fn(),
}));
jest.mock('@/api/connection-clients', () => ({
  resolveClient: jest.fn(() => null),
  sessionReady: jest.fn(() => true),
}));
jest.mock('@/stores/session', () => ({
  onConnectionRemoved: jest.fn(() => () => {}),
  useSession: jest.fn(),
}));
jest.mock('@/api/provider', () => {
  const { QueryClient } = jest.requireActual('@tanstack/react-query');
  return {
    queryClient: new QueryClient(),
    useApi: jest.fn(),
    useApis: jest.fn(),
    useCid: jest.fn(),
    useOptionalApi: jest.fn(),
  };
});

/* eslint-disable import/first */
import { allProgressQuery, fetchBookProgress } from '@/api/hooks';
import { setKeptOfflineCheck } from '@/downloads/kept-offline';
import { loadInitialProgress, readMirror, writeMirror } from '@/playback/progress-sync';
/* eslint-enable import/first */

const BOOK = 'Dresden/Death Masks.m4b';

/** Death Masks at 70% (chapter 9), saved by another device. */
const serverPlace: Progress = {
  library_id: 1,
  path: BOOK,
  position: 3570,
  duration: 5100,
  finished: false,
  playback_speed: 1.25,
  version: 7,
  device_id: 'phone',
  updated_at: '2026-10-28T20:00:00Z',
};

const online = (p: Progress | null) =>
  ({ getProgress: jest.fn(async () => p), saveProgress: jest.fn() }) as unknown as ApiClient;
const offline = () =>
  ({
    getProgress: jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    }),
    saveProgress: jest.fn(),
  }) as unknown as ApiClient;

const signal = () => new AbortController().signal;

beforeEach(async () => {
  await AsyncStorage.clear();
  setKeptOfflineCheck((cid, lib, path) => cid === 'c1' && lib === 1 && path === BOOK);
});

afterAll(() => setKeptOfflineCheck(() => false));

describe('a downloaded book offline (PLAYER-01)', () => {
  it("opens at the server's place once its progress was read online", async () => {
    await expect(fetchBookProgress(online(serverPlace), 'c1', 1, BOOK, signal())).resolves.toBe(
      serverPlace,
    );

    // Offline: the book page's read, and the player's resume lookup (with a client, and
    // with none: a token that failed to hydrate).
    await expect(fetchBookProgress(offline(), 'c1', 1, BOOK, signal())).resolves.toMatchObject({
      position: 3570,
      playback_speed: 1.25,
    });
    for (const api of [offline(), null]) {
      const r = await loadInitialProgress(api, 'c1', 1, BOOK);
      expect(r.kind).toBe('progress');
      expect(r.kind === 'progress' && r.progress.position).toBe(3570);
    }
  });

  it('a book not downloaded is not kept (its resume lookup still fails safe offline)', async () => {
    await fetchBookProgress(online(serverPlace), 'c1', 1, 'Other/Book.m4b', signal());
    await expect(fetchBookProgress(offline(), 'c1', 1, 'Other/Book.m4b', signal())).resolves.toBe(
      null,
    );
    await expect(loadInitialProgress(offline(), 'c1', 1, 'Other/Book.m4b')).resolves.toEqual({
      kind: 'failed',
    });
  });

  it("never regresses a newer save of this device's own", async () => {
    // Listened past the server's place (the save is in the mirror, the queue empty: it was
    // sent), then an older server answer is read.
    await writeMirror({
      connectionId: 'c1',
      libraryId: 1,
      path: BOOK,
      position: 3700,
      duration: 5100,
      finished: false,
      playback_speed: 1,
      device_id: 'this-device',
      updated_at: '2026-10-29T08:00:00Z',
    });
    await fetchBookProgress(online(serverPlace), 'c1', 1, BOOK, signal());

    expect((await readMirror('c1', 1, BOOK))?.position).toBe(3700);
    const r = await loadInitialProgress(null, 'c1', 1, BOOK);
    expect(r.kind === 'progress' && r.progress.position).toBe(3700);
  });

  it('a newer server place replaces an older one kept earlier', async () => {
    await fetchBookProgress(online(serverPlace), 'c1', 1, BOOK, signal());
    const later = { ...serverPlace, position: 4000, updated_at: '2026-10-29T09:00:00Z' };
    await fetchBookProgress(online(later), 'c1', 1, BOOK, signal());

    const r = await loadInitialProgress(null, 'c1', 1, BOOK);
    expect(r.kind === 'progress' && r.progress.position).toBe(4000);
  });
});

// fe#198: Home's progress list keeps the downloaded books' places too, so a book whose page
// was not opened before going offline still resumes at another device's newer place.
describe("the progress list keeps the downloaded books' places", () => {
  const listClient = (rows: Progress[]) =>
    ({ allProgress: jest.fn(async () => rows) }) as unknown as ApiClient;
  const streamed: Progress = { ...serverPlace, path: 'Other/Streamed.m4b' };

  async function readList(rows: Progress[]) {
    const fn = allProgressQuery('c1', listClient(rows)).queryFn as () => Promise<Progress[]>;
    return fn();
  }

  it('mirrors a downloaded book from the list, and only a downloaded one', async () => {
    await expect(readList([serverPlace, streamed])).resolves.toEqual([serverPlace, streamed]);
    expect(await readMirror('c1', 1, BOOK)).toMatchObject({ position: 3570, device_id: 'phone' });
    expect(await readMirror('c1', 1, streamed.path)).toBeNull();
    // Offline, the resume lookup opens there.
    await expect(loadInitialProgress(offline(), 'c1', 1, BOOK)).resolves.toMatchObject({
      kind: 'progress',
      progress: { position: 3570 },
    });
  });

  it("keeps this device's own newer save", async () => {
    const mine = {
      connectionId: 'c1',
      libraryId: 1,
      path: BOOK,
      position: 120,
      duration: 5100,
      finished: false,
      playback_speed: 1,
      device_id: 'this-device',
      updated_at: '2026-10-29T08:00:00Z',
    };
    await writeMirror(mine);
    await readList([serverPlace]);
    expect(await readMirror('c1', 1, BOOK)).toMatchObject({ position: 120 });
  });

  it('the list read again with no place moved writes nothing', async () => {
    await readList([serverPlace]);
    // The storage mock's setItem is a jest.fn already: its calls so far cleared, not restored.
    const write = AsyncStorage.setItem as jest.Mock;
    write.mockClear();
    await readList([serverPlace]);
    expect(write.mock.calls.filter(([key]) => key === 'audiosilo.progressMirror')).toEqual([]);
    await readList([{ ...serverPlace, position: 3600, updated_at: '2026-10-28T20:10:00Z' }]);
    expect(await readMirror('c1', 1, BOOK)).toMatchObject({ position: 3600 });
  });
});
