const mockItem = jest.fn();
const mockChapters = jest.fn();
let mockClient: object | null;
jest.mock('@/api/connection-clients', () => ({ resolveClient: () => mockClient }));
jest.mock('@/api/provider', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({}),
);
const mockPlayBook = jest.fn();
const mockSetRate = jest.fn();
jest.mock('@/playback/store', () => ({
  usePlayer: {
    getState: () => ({
      playBook: (...a: unknown[]) => mockPlayBook(...a),
      setRate: (r: number) => mockSetRate(r),
    }),
  },
}));

const mockDrop = jest.fn();
jest.mock('./drop-started', () => ({ dropStartedBook: (...a: unknown[]) => mockDrop(...a) }));
const mockRequestFetch = jest.fn();
const mockCancelUnless = jest.fn();
const mockCancelOf = jest.fn();
let mockLatestStart: string | null = null;
let mockFetchStarting = true;
jest.mock('@/playback/episode-fetch', () => ({
  isAbsentEpisode: jest.requireActual('@/playback/episode-fetch').isAbsentEpisode,
  needsEpisodeFetch: jest.requireActual('@/playback/episode-fetch').needsEpisodeFetch,
  requestEpisodeFetch: (...a: unknown[]) => mockRequestFetch(...a),
  // The real bookkeeping of the start asked for last, observed.
  cancelEpisodeFetchUnless: (key: string) => {
    mockLatestStart = key;
    mockCancelUnless(key);
  },
  cancelEpisodeFetchOf: (key: string) => mockCancelOf(key),
  isLatestStart: (key: string) => mockLatestStart === key,
  isEpisodeFetchStarting: () => mockFetchStarting,
}));

/* eslint-disable import/first */
import { queryClient } from '@/api/provider';
import { useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';

import { FRESH_SOURCE_WAIT_MS, startBookInPlace } from './start-book';
/* eslint-enable import/first */

const target = { connectionId: 'c1', libraryId: 2, path: 'Weir/Project Hail Mary' };

function downloadedEntry(): DownloadEntry {
  return {
    connectionId: 'c1',
    libraryId: 2,
    path: target.path,
    title: 'Project Hail Mary',
    status: 'downloaded',
    progress: 1,
    bytes: 0,
    totalBytes: 0,
    manifest: {
      book: { rel_path: target.path, title: 'From the download' } as never,
      chapters: { chapters: [], files: [], from: 'download' } as never,
      files: [],
      coverUri: null,
      savedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

beforeEach(() => {
  queryClient.clear();
  useDownloads.setState({ entries: {} });
  mockClient = {
    item: (...a: unknown[]) => mockItem(...a),
    chapters: (...a: unknown[]) => mockChapters(...a),
  };
  mockItem.mockReset().mockResolvedValue({ rel_path: target.path });
  mockChapters.mockReset().mockResolvedValue({ chapters: [], files: [] });
  mockPlayBook.mockReset().mockResolvedValue(undefined);
  mockSetRate.mockReset();
  mockDrop.mockReset().mockResolvedValue(undefined);
  mockRequestFetch.mockReset();
  mockCancelUnless.mockReset();
  mockCancelOf.mockReset();
  mockLatestStart = null;
  mockFetchStarting = true;
});

/** Until `fn` has been called (a start reaches its reads after a few awaits). */
async function asked(fn: jest.Mock) {
  for (let i = 0; i < 50 && fn.mock.calls.length === 0; i++) await Promise.resolve();
}

describe('startBookInPlace', () => {
  it("refuses another person's book before fetching anything (the car's old items)", async () => {
    try {
      useProfiles.setState({
        hydrated: true,
        profiles: [
          { id: 'sam', name: 'Sam', connectionIds: ['c9'] },
          { id: 'alex', name: 'Alex', connectionIds: ['c1'] },
        ],
        activeProfileId: 'sam',
      });
      await expect(startBookInPlace(target)).resolves.toBe(false);
      expect(mockItem).not.toHaveBeenCalled();
      expect(mockPlayBook).not.toHaveBeenCalled();
    } finally {
      resetProfilesForTests();
    }
  });

  it('plays the book with its item and chapters, from the saved place', async () => {
    await expect(startBookInPlace(target)).resolves.toBe(true);
    expect(mockItem).toHaveBeenCalledWith(2, target.path, expect.anything());
    expect(mockPlayBook).toHaveBeenCalledWith(
      'c1',
      2,
      { rel_path: target.path },
      { chapters: [], files: [] },
      undefined,
      undefined,
      undefined,
    );
    // The resume lookup restores the saved speed itself.
    expect(mockSetRate).not.toHaveBeenCalled();
  });

  it('takes the book it starts off Up next, as Play now does (PLAYER-04)', async () => {
    await expect(startBookInPlace(target)).resolves.toBe(true);
    expect(mockDrop).toHaveBeenCalledWith('c1', 2, target.path, target.path);
  });

  it('drops both the book and the path it was asked for when the server moved it (#122)', async () => {
    // A queue entry that is no longer exactly a book (a part path the server now resolves
    // to the book folder) must leave Up next too once the book it names has started.
    mockItem.mockResolvedValue({ rel_path: 'Folder' });
    await expect(startBookInPlace({ ...target, path: 'Folder/Part 1' })).resolves.toBe(true);
    expect(mockDrop).toHaveBeenCalledWith('c1', 2, 'Folder', 'Folder/Part 1');
  });

  it('leaves Up next alone when the book does not start', async () => {
    mockClient = null;
    await expect(startBookInPlace(target)).resolves.toBe(false);
    mockClient = { item: () => Promise.reject(new Error('offline')), chapters: mockChapters };
    await expect(startBookInPlace(target)).rejects.toThrow();
    expect(mockDrop).not.toHaveBeenCalled();
  });

  it('starts at a given place, at the speed the caller passes, from the start', async () => {
    await expect(startBookInPlace(target, { position: 1234, speed: 1.25 })).resolves.toBe(true);
    expect(mockPlayBook).toHaveBeenCalledWith(
      'c1',
      2,
      expect.anything(),
      expect.anything(),
      1234,
      undefined,
      1.25,
    );
    // Not a second speed change once the book is already playing (an audible flip).
    expect(mockSetRate).not.toHaveBeenCalled();
  });

  it('starts at a file by index, for a book whose durations are unknown', async () => {
    await startBookInPlace(target, { track: 2 });
    expect(mockPlayBook).toHaveBeenCalledWith(
      'c1',
      2,
      expect.anything(),
      expect.anything(),
      undefined,
      2,
      undefined,
    );
  });

  it('does nothing when the connection is gone', async () => {
    mockClient = null;
    await expect(startBookInPlace(target)).resolves.toBe(false);
    expect(mockPlayBook).not.toHaveBeenCalled();
  });

  // Phase 6: a downloaded book starts from its download, with no server: CarPlay (and any
  // other caller) can start it offline, and while its connection's token failed to hydrate.
  it('starts a downloaded book from its download, offline and with its connection gone', async () => {
    mockClient = null;
    useDownloads.setState({ entries: { [`c1:2:${target.path}`]: downloadedEntry() } });
    await expect(startBookInPlace(target)).resolves.toBe(true);
    expect(mockItem).not.toHaveBeenCalled();
    expect(mockChapters).not.toHaveBeenCalled();
    expect(mockPlayBook).toHaveBeenCalledWith(
      'c1',
      2,
      { rel_path: target.path, title: 'From the download' },
      { chapters: [], files: [], from: 'download' },
      undefined,
      undefined,
      undefined,
    );
  });

  it("starts a downloaded book with its server's item and chapters when it answers", async () => {
    useDownloads.setState({ entries: { [`c1:2:${target.path}`]: downloadedEntry() } });
    mockChapters.mockResolvedValue({ chapters: [{ title: 'Ch 1' }], files: [] });
    await expect(startBookInPlace(target)).resolves.toBe(true);
    expect(mockPlayBook).toHaveBeenCalledWith(
      'c1',
      2,
      { rel_path: target.path },
      { chapters: [{ title: 'Ch 1' }], files: [] },
      undefined,
      undefined,
      undefined,
    );
  });

  it("starts a downloaded book from its download's copy when the server fails or is slow", async () => {
    useDownloads.setState({ entries: { [`c1:2:${target.path}`]: downloadedEntry() } });
    mockChapters.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(startBookInPlace(target)).resolves.toBe(true);
    expect(mockPlayBook).toHaveBeenLastCalledWith(
      'c1',
      2,
      { rel_path: target.path, title: 'From the download' },
      { chapters: [], files: [], from: 'download' },
      undefined,
      undefined,
      undefined,
    );

    queryClient.clear();
    jest.useFakeTimers();
    try {
      mockItem.mockImplementationOnce(() => new Promise(() => {})); // a server that never answers
      const starting = startBookInPlace(target);
      await jest.advanceTimersByTimeAsync(FRESH_SOURCE_WAIT_MS);
      await expect(starting).resolves.toBe(true);
      expect(mockPlayBook).toHaveBeenLastCalledWith(
        'c1',
        2,
        { rel_path: target.path, title: 'From the download' },
        { chapters: [], files: [], from: 'download' },
        undefined,
        undefined,
        undefined,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('joins a start of the same book already on its way, never a second one (8b-1, D2)', async () => {
    let answer: (v: unknown) => void = () => undefined;
    mockItem.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const first = startBookInPlace(target);
    // A second tap while the item is looked up: the same start.
    expect(startBookInPlace(target)).toBe(first);
    // Another place in the same book is its own start.
    const elsewhere = startBookInPlace(target, { position: 60 });
    expect(elsewhere).not.toBe(first);
    await asked(mockItem);
    answer({ rel_path: target.path });
    await expect(first).resolves.toBe(true);
    await elsewhere;
    expect(mockPlayBook).toHaveBeenCalledTimes(2);
    // Settled: a tap afterwards starts it again.
    await startBookInPlace(target);
    expect(mockPlayBook).toHaveBeenCalledTimes(3);
  });

  it('starts a book again when another book was started after it: the last tap wins', async () => {
    let answer: (v: unknown) => void = () => undefined;
    mockItem.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const first = startBookInPlace(target);
    // Story B, then A again while A's first start is still on its way: B's start would
    // take the player over A's, so joining that one would drop the last tap.
    const other = startBookInPlace({ ...target, path: 'Other/Story' });
    const again = startBookInPlace(target);
    expect(again).not.toBe(first);
    await asked(mockItem);
    answer({ rel_path: target.path });
    await Promise.all([first, other, again]);
    // A, B, then A again: three starts (A's twice), never two.
    expect(mockPlayBook).toHaveBeenCalledTimes(3);
    // Settled: the replaced start left no entry behind; a tap now is a fresh start.
    await startBookInPlace(target);
    expect(mockPlayBook).toHaveBeenCalledTimes(4);
  });

  it('joins a start that fails, then lets the next one try again', async () => {
    let fail: (e: Error) => void = () => undefined;
    mockChapters.mockImplementationOnce(() => new Promise((_, r) => (fail = r)));
    const first = startBookInPlace(target);
    const again = startBookInPlace(target);
    await asked(mockChapters);
    fail(new Error('offline'));
    await expect(first).rejects.toThrow('offline');
    await expect(again).rejects.toThrow('offline');
    await expect(startBookInPlace(target)).resolves.toBe(true);
  });

  it('rejects, without playing, when the book cannot be fetched', async () => {
    mockChapters.mockRejectedValue(new Error('offline'));
    await expect(startBookInPlace(target)).rejects.toThrow('offline');
    expect(mockPlayBook).not.toHaveBeenCalled();
  });
});

// Bridge Phase 2d-1: an episode its server has not fetched yet waits for the fetch.
describe('startBookInPlace, a podcast episode', () => {
  const episode = (downloaded: boolean) => ({
    rel_path: target.path,
    title: 'Monday',
    episode: { show_path: 'Weir', downloaded },
  });
  const serverFetches = (podcast_fetch: boolean) =>
    queryClient.setQueryData(['server', 'c1'], { capabilities: { podcast_fetch } });

  it('hands an episode not on its server to the fetch, never to playBook', async () => {
    serverFetches(true);
    mockItem.mockResolvedValue(episode(false));
    await expect(startBookInPlace(target, { position: 30 })).resolves.toBe(true);
    expect(mockPlayBook).not.toHaveBeenCalled();
    expect(mockRequestFetch).toHaveBeenCalledWith(target, episode(false), { position: 30 });
    // It leaves Up next when the fetch starts it (`fetched`), not before.
    expect(mockDrop).not.toHaveBeenCalled();
  });

  it('plays a downloaded episode at once', async () => {
    serverFetches(true);
    mockItem.mockResolvedValue(episode(true));
    await expect(startBookInPlace(target)).resolves.toBe(true);
    expect(mockRequestFetch).not.toHaveBeenCalled();
    expect(mockPlayBook).toHaveBeenCalledTimes(1);
  });

  it('plays it as before on a server that does not fetch on demand', async () => {
    serverFetches(false);
    mockItem.mockResolvedValue(episode(false));
    await startBookInPlace(target);
    expect(mockRequestFetch).not.toHaveBeenCalled();
    expect(mockPlayBook).toHaveBeenCalledTimes(1);
  });

  it('starts it once the fetch is done (`fetched`), never handing it back', async () => {
    serverFetches(true);
    mockItem.mockResolvedValue(episode(false));
    await expect(startBookInPlace(target, {}, { fetched: true })).resolves.toBe(true);
    expect(mockRequestFetch).not.toHaveBeenCalled();
    expect(mockPlayBook).toHaveBeenCalledTimes(1);
  });

  it('ends a fetch on its way for anything else it starts', async () => {
    await startBookInPlace(target);
    expect(mockCancelUnless).toHaveBeenCalledWith(`c1:2:${target.path}`);
  });

  it('ends a fetch of the same episode when it plays it itself (on its server now)', async () => {
    serverFetches(true);
    mockItem.mockResolvedValue(episode(true));
    await startBookInPlace(target);
    expect(mockCancelOf).toHaveBeenCalledWith(`c1:2:${target.path}`);
    expect(mockPlayBook).toHaveBeenCalledTimes(1);
  });

  it('hands nothing to the fetch once a start of another book took over', async () => {
    serverFetches(true);
    let release: (b: unknown) => void = () => {};
    mockItem.mockReturnValueOnce(new Promise((r) => (release = r)));
    const first = startBookInPlace(target);
    await asked(mockItem);
    // A tap on another book while the episode is looked up.
    const other = { ...target, path: 'Weir/Artemis' };
    mockItem.mockResolvedValue({ rel_path: other.path });
    await startBookInPlace(other);
    release(episode(false));
    await expect(first).resolves.toBe(false);
    expect(mockRequestFetch).not.toHaveBeenCalled();
    expect(mockPlayBook).toHaveBeenCalledTimes(1);
    expect(mockPlayBook.mock.calls[0][2]).toEqual({ rel_path: other.path });
  });

  it("plays the fetch's own start only while it stands (no Cancel or other start since)", async () => {
    serverFetches(true);
    mockItem.mockResolvedValue(episode(false));
    mockFetchStarting = false;
    await expect(startBookInPlace(target, {}, { fetched: true })).resolves.toBe(false);
    expect(mockPlayBook).not.toHaveBeenCalled();
  });
});
