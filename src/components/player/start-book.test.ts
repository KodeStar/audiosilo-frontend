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

/* eslint-disable import/first */
import { queryClient } from '@/api/provider';
import { useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';

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
});

describe('startBookInPlace', () => {
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

  it('rejects, without playing, when the book cannot be fetched', async () => {
    mockChapters.mockRejectedValue(new Error('offline'));
    await expect(startBookInPlace(target)).rejects.toThrow('offline');
    expect(mockPlayBook).not.toHaveBeenCalled();
  });
});
