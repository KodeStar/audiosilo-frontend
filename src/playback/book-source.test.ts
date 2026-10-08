const mockItem = jest.fn();
const mockChapters = jest.fn();
let mockClient: object | null;
jest.mock('@/api/connection-clients', () => ({ resolveClient: () => mockClient }));
jest.mock('@/api/provider', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({}),
);

/* eslint-disable import/first */
import { queryClient } from '@/api/provider';
import { useDownloads } from '@/downloads/store';
import type { DownloadEntry, DownloadManifest } from '@/downloads/types';

import { bookSourceOf, localFromManifest, resumeStart } from './book-source';
/* eslint-enable import/first */

const ref = { connectionId: 'c1', libraryId: 2, path: 'A/Book' };

const manifest = {
  book: { rel_path: 'A/Book', title: 'Downloaded' },
  chapters: { chapters: [], files: [] },
  files: [
    { relPath: 'A/Book/1.mp3', localUri: 'file:///d/1.mp3' },
    { relPath: 'A/Book/2.mp3', localUri: 'file:///d/2.mp3' },
  ],
  coverUri: 'file:///d/cover.jpg',
  savedAt: '2026-01-01T00:00:00.000Z',
} as unknown as DownloadManifest;

function entry(status: DownloadEntry['status']): DownloadEntry {
  return {
    ...ref,
    title: 'Downloaded',
    status,
    progress: 1,
    bytes: 0,
    totalBytes: 0,
    manifest,
  };
}

beforeEach(() => {
  queryClient.clear();
  useDownloads.setState({ entries: {} });
  mockClient = {
    item: (...a: unknown[]) => mockItem(...a),
    chapters: (...a: unknown[]) => mockChapters(...a),
  };
  mockItem.mockReset().mockResolvedValue({ rel_path: 'A/Book', title: 'From the server' });
  mockChapters.mockReset().mockResolvedValue({ chapters: [], files: [], from: 'server' });
});

describe('localFromManifest', () => {
  it('maps each file to its local copy, with the local cover', () => {
    const local = localFromManifest(manifest);
    expect([...local.files]).toEqual([
      ['A/Book/1.mp3', 'file:///d/1.mp3'],
      ['A/Book/2.mp3', 'file:///d/2.mp3'],
    ]);
    expect(local.artwork).toBe('file:///d/cover.jpg');
    expect(localFromManifest({ ...manifest, coverUri: null }).artwork).toBeUndefined();
  });
});

describe('resumeStart', () => {
  it('resumes an unfinished book at its place, and starts a finished one again at 0', () => {
    expect(resumeStart({ finished: false, position: 120 })).toBe(120);
    expect(resumeStart({ finished: true, position: 7190 })).toBe(0);
    expect(resumeStart({ finished: true, position: 300 })).toBe(0); // marked finished mid-book
    expect(resumeStart({ finished: false, position: 0 })).toBe(0);
  });
});

describe('bookSourceOf', () => {
  it('reads a downloaded book from its download, with no server and no connection', async () => {
    mockClient = null;
    useDownloads.setState({ entries: { 'c1:2:A/Book': entry('downloaded') } });
    const source = await bookSourceOf(ref);
    expect(source).toMatchObject({ book: { title: 'Downloaded' }, chapters: manifest.chapters });
    expect(source!.local!.artwork).toBe('file:///d/cover.jpg');
    expect(mockItem).not.toHaveBeenCalled();
  });

  it('reads any other book through the query cache, with no local files', async () => {
    useDownloads.setState({ entries: { 'c1:2:A/Book': entry('downloading') } });
    const source = await bookSourceOf(ref);
    expect(source).toEqual({
      book: { rel_path: 'A/Book', title: 'From the server' },
      chapters: { chapters: [], files: [], from: 'server' },
    });
    // Fresh in the cache: a second read asks nothing.
    await bookSourceOf(ref);
    expect(mockItem).toHaveBeenCalledTimes(1);
  });

  it('answers null when the book is not downloaded and its connection is gone', async () => {
    mockClient = null;
    expect(await bookSourceOf(ref)).toBeNull();
  });

  it('rejects when the server cannot be read', async () => {
    mockChapters.mockRejectedValue(new Error('offline'));
    await expect(bookSourceOf(ref)).rejects.toThrow('offline');
  });
});
