// The app's EPUB source (Bridge Phase 3b-2): the download's copy first, else the reader's
// cache file, fetched with the Authorization header and fetched again when the server's
// ebook changes size; dropped with its connection.

import type { ApiClient } from '@/api/client';

// An in-memory file tree standing in for expo-file-system: uri -> size (a file) or 'dir'.
const mockTree = new Map<string, number | 'dir'>();
const mockDownload = jest.fn(
  async (_url: string, _dest: string, _opts: { headers?: Record<string, string> }) => 1000,
);
jest.mock('expo-file-system', () => {
  const join = (parts: unknown[]) =>
    parts
      .map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri))
      .join('/')
      .replace(/\/+$/, '');
  class MockFile {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    get exists() {
      return typeof mockTree.get(this.uri) === 'number';
    }
    get size() {
      const v = mockTree.get(this.uri);
      return typeof v === 'number' ? v : null;
    }
    delete() {
      mockTree.delete(this.uri);
    }
    async move(to: MockFile) {
      mockTree.set(to.uri, mockTree.get(this.uri) as number);
      mockTree.delete(this.uri);
      this.uri = to.uri;
    }
    static createDownloadTask(
      url: string,
      dest: MockFile,
      opts: { headers?: Record<string, string> },
    ) {
      return {
        downloadAsync: async () => {
          mockTree.set(dest.uri, await mockDownload(url, dest.uri, opts));
          return dest;
        },
      };
    }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    get exists() {
      return [...mockTree.keys()].some((k) => k === this.uri || k.startsWith(`${this.uri}/`));
    }
    create() {
      mockTree.set(this.uri, 'dir');
    }
    delete() {
      for (const k of [...mockTree.keys()]) {
        if (k === this.uri || k.startsWith(`${this.uri}/`)) mockTree.delete(k);
      }
    }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { cache: 'file:///cache' } };
});
const mockRead = jest.fn(async (_uri: string, _o: unknown) => 'QUJD');
jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: (uri: string, o: unknown) => mockRead(uri, o),
}));
const mockDownloaded = jest.fn((_ref: unknown): unknown => undefined);
jest.mock('@/downloads/store', () => ({
  downloadedEntryOf: (ref: unknown) => mockDownloaded(ref),
}));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';

import { cacheUsable, chunkReader, clearEbookCache, localEbook } from './ebook-file.native';
/* eslint-enable import/first */

const api = {
  ebookRequest: (lib: number, path: string) => ({
    url: `https://h/api/v1/libraries/${lib}/ebook?path=${encodeURIComponent(path)}`,
    headers: { Authorization: 'Bearer tok' },
  }),
} as unknown as ApiClient;

const args = { api, connectionId: 'c1', libraryId: 2, path: 'A/Book', size: 1000 };
const CACHED = /^file:\/\/\/cache\/reader\/c1\/2\/A_Book-[0-9a-f]+\/book\.epub$/;

beforeEach(() => {
  mockTree.clear();
  jest.clearAllMocks();
  mockDownloaded.mockReturnValue(undefined);
  mockDownload.mockImplementation(async () => 1000);
});

describe('cacheUsable', () => {
  it('takes a cached copy only at the server’s size, and never an empty one', () => {
    expect(cacheUsable(1000, 1000)).toBe(true);
    expect(cacheUsable(999, 1000)).toBe(false);
    expect(cacheUsable(0, 0)).toBe(false);
    expect(cacheUsable(null, 1000)).toBe(false);
    expect(cacheUsable(undefined, 1000)).toBe(false);
  });
});

describe('localEbook', () => {
  it('reads a downloaded book’s own copy, fetching nothing', async () => {
    mockTree.set('file:///docs/downloads/c1/2/b/book.epub', 1234);
    mockDownloaded.mockReturnValue({
      manifest: { ebookUri: 'file:///docs/downloads/c1/2/b/book.epub' },
    });
    await expect(localEbook(args)).resolves.toEqual({
      uri: 'file:///docs/downloads/c1/2/b/book.epub',
      size: 1234,
      downloaded: true,
    });
    expect(mockDownloaded).toHaveBeenCalledWith({
      connectionId: 'c1',
      libraryId: 2,
      path: 'A/Book',
    });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('fetches into the cache with the Authorization header (no token in the url)', async () => {
    const got = await localEbook(args);
    expect(got.uri).toMatch(CACHED);
    expect(got).toMatchObject({ size: 1000, downloaded: false });
    const [url, dest, opts] = mockDownload.mock.calls[0];
    expect(url).not.toMatch(/token=/);
    expect(dest).toMatch(/book\.epub\.part$/);
    expect(opts.headers).toEqual({ Authorization: 'Bearer tok' });
    // The partial file became the book: nothing else is left.
    expect([...mockTree.keys()].filter((k) => k.endsWith('.part'))).toEqual([]);
  });

  it('fetches when the download’s copy is gone from the device', async () => {
    mockDownloaded.mockReturnValue({ manifest: { ebookUri: 'file:///docs/gone/book.epub' } });
    expect((await localEbook(args)).uri).toMatch(CACHED);
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached copy while the server’s size is the same, and fetches a changed one', async () => {
    await localEbook(args);
    await localEbook(args);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    mockDownload.mockImplementation(async () => 2000);
    expect((await localEbook({ ...args, size: 2000 })).size).toBe(2000);
    expect(mockDownload).toHaveBeenCalledTimes(2);
  });

  it('turns the server’s refusal into its status (404: the ebook is gone), leaving no file', async () => {
    mockDownload.mockRejectedValue(new Error('server returned HTTP 404'));
    const failed = await localEbook(args).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ApiError);
    expect((failed as ApiError).status).toBe(404);
    expect([...mockTree.values()].filter((v) => v !== 'dir')).toEqual([]);
  });

  it('passes on a network failure as it is', async () => {
    const offline = new Error('The Internet connection appears to be offline.');
    mockDownload.mockRejectedValue(offline);
    await expect(localEbook(args)).rejects.toBe(offline);
  });

  it('refuses an empty download', async () => {
    mockDownload.mockImplementation(async () => 0);
    await expect(localEbook(args)).rejects.toThrow('empty');
    expect([...mockTree.values()].filter((v) => v !== 'dir')).toEqual([]);
  });
});

describe('chunkReader', () => {
  it('reads each piece as base64, natively', async () => {
    await expect(chunkReader('file:///x/book.epub')(262144, 10)).resolves.toBe('QUJD');
    expect(mockRead).toHaveBeenCalledWith('file:///x/book.epub', {
      encoding: 'base64',
      position: 262144,
      length: 10,
    });
  });
});

describe('clearEbookCache', () => {
  it('drops one connection’s cached copies and no other’s', async () => {
    await localEbook(args);
    await localEbook({ ...args, connectionId: 'c2' });
    await clearEbookCache('c1');
    const files = [...mockTree.entries()].filter(([, v]) => v !== 'dir').map(([k]) => k);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\/reader\/c2\//);
  });
});
