// The app's EPUB source (Bridge Phase 3b-2): the download's copy first, else the reader's
// cache file `book-<size>.epub`, named by the server's size and the book while it is there,
// fetched with the Authorization header to a part of its own; dropped with its connection.

import type { ApiClient } from '@/api/client';
import { pathSlug } from '@/lib/path-slug';

// An in-memory file tree standing in for expo-file-system: uri -> size (a file) or 'dir'.
const mockTree = new Map<string, number | 'dir'>();
type MockOptions = { headers?: Record<string, string>; signal?: AbortSignal; sessionType?: string };
const mockDownload = jest.fn(async (_url: string, _dest: string, _opts: MockOptions) => 1000);
const mockBytes = jest.fn(async (_uri: string) => new Uint8Array([97, 98, 99]));
// When each file was written (its `modificationTime`), and the free space the device reports.
const mockTimes = new Map<string, number>();
let mockFree = 10 * 1024 ** 3;
let mockMoveFails = false;
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'sha256' },
  digest: (algorithm: string, bytes: Uint8Array) =>
    Promise.resolve(jest.requireActual('node:crypto').createHash(algorithm).update(bytes).digest()),
}));
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
    get name() {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }
    get exists() {
      return typeof mockTree.get(this.uri) === 'number';
    }
    // As iOS sends it since SDK 58 (a Swift Int64 is a bigint): every size read here must
    // come back to the caller as a number.
    get size() {
      const v = mockTree.get(this.uri);
      return typeof v === 'number' ? BigInt(v) : null;
    }
    get modificationTime() {
      return mockTimes.get(this.uri) ?? null;
    }
    bytes() {
      return mockBytes(this.uri);
    }
    delete() {
      if (!this.exists) throw new Error(`nothing at ${this.uri}`);
      mockTree.delete(this.uri);
    }
    // Like the native move: a file already at the destination is an error without `overwrite`.
    async move(to: MockFile, opts?: { overwrite?: boolean }) {
      if (mockMoveFails) throw new Error('Unable to move the file');
      if (!this.exists) throw new Error(`nothing at ${this.uri}`);
      if (to.exists && !opts?.overwrite) throw new Error('Destination already exists');
      mockTree.set(to.uri, mockTree.get(this.uri) as number);
      mockTree.delete(this.uri);
      this.uri = to.uri;
    }
    static createDownloadTask(url: string, dest: MockFile, opts: MockOptions) {
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
    // The folder's own entries: its files, and a folder for each first step below it.
    list() {
      const files: MockFile[] = [];
      const dirs = new Set<string>();
      for (const [k, v] of mockTree) {
        if (!k.startsWith(`${this.uri}/`)) continue;
        const rest = k.slice(this.uri.length + 1);
        const step = rest.split('/')[0];
        if (rest.includes('/') || v === 'dir') dirs.add(`${this.uri}/${step}`);
        else files.push(new MockFile(k));
      }
      return [...[...dirs].map((d) => new MockDirectory(d)), ...files];
    }
  }
  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: {
      cache: 'file:///cache',
      get availableDiskSpace() {
        return mockFree;
      },
    },
  };
});
const mockRead = jest.fn(async (_uri: string, _o: unknown) => 'QUJD');
jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: (uri: string, o: unknown) => mockRead(uri, o),
}));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';

import { EbookStorageError, EbookTooLargeError, MAX_EBOOK_BYTES } from './ebook-errors';
import {
  cachedEbookUri,
  chunkReader,
  clearEbookCache,
  hasLocalEbook,
  identifyEbook,
  localEbook,
  READER_CACHE_MAX_BYTES,
} from './ebook-file.native';
/* eslint-enable import/first */

const api = {
  ebookRequest: (lib: number, path: string) => ({
    url: `https://h/api/v1/libraries/${lib}/ebook?path=${encodeURIComponent(path)}`,
    headers: { Authorization: 'Bearer tok' },
  }),
} as unknown as ApiClient;

const args = { api, connectionId: 'c1', libraryId: 2, path: 'A/Book', size: 1000 };
const FOLDER = `file:///cache/reader/c1/2/${pathSlug('A/Book')}`;
const BOOK = `${FOLDER}/book-1000.epub`;
const PART = /\/book-1000\.epub\.\d+\.part$/;
const SAVED = 'file:///docs/downloads/c1/2/b/book.epub';

/** The files in the tree, not its folders. */
const files = () => [...mockTree.entries()].filter(([, v]) => v !== 'dir').map(([k]) => k);

beforeEach(() => {
  mockTree.clear();
  mockTimes.clear();
  mockFree = 10 * 1024 ** 3;
  mockMoveFails = false;
  jest.clearAllMocks();
  mockDownload.mockImplementation(async () => 1000);
  mockBytes.mockResolvedValue(new Uint8Array([97, 98, 99]));
});

it('identifies the selected native file by its actual bytes and length', async () => {
  await expect(identifyEbook({ uri: SAVED, size: 999 }, 'download')).resolves.toEqual({
    source: 'download',
    size: 3,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  });
  expect(mockBytes).toHaveBeenCalledWith(SAVED);
});

describe('localEbook', () => {
  it('reads the download’s own copy at its own size, fetching nothing', async () => {
    mockTree.set(SAVED, 1234);
    await expect(localEbook({ ...args, saved: SAVED })).resolves.toEqual({
      uri: SAVED,
      size: 1234,
    });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('fetches when the download’s copy is gone from the device, or empty', async () => {
    await expect(localEbook({ ...args, saved: 'file:///docs/gone/book.epub' })).resolves.toEqual({
      uri: BOOK,
      size: 1000,
    });
    mockTree.clear();
    mockTree.set(SAVED, 0);
    await expect(localEbook({ ...args, saved: SAVED })).resolves.toEqual({ uri: BOOK, size: 1000 });
    expect(mockDownload).toHaveBeenCalledTimes(2);
  });

  it('fetches into `book-<size>.epub` with the Authorization header, in a foreground session', async () => {
    const abort = new AbortController();
    await expect(localEbook({ ...args, signal: abort.signal })).resolves.toEqual({
      uri: BOOK,
      size: 1000,
    });
    const [url, dest, opts] = mockDownload.mock.calls[0];
    expect(url).not.toMatch(/token=/);
    expect(dest.startsWith(`${FOLDER}/`)).toBe(true);
    expect(dest).toMatch(PART);
    expect(opts).toEqual({
      headers: { Authorization: 'Bearer tok' },
      signal: abort.signal,
      sessionType: 'foreground',
    });
    // The part became the book: nothing else is left.
    expect(files()).toEqual([BOOK]);
  });

  it('says a fetch as it starts, before any file of it, and never for a copy already here (fe#193)', async () => {
    const files0: string[][] = [];
    const onFetch = jest.fn(() => files0.push(files()));
    await localEbook({ ...args, onFetch });
    expect(onFetch).toHaveBeenCalledTimes(1);
    expect(files0[0]).toEqual([]);
    // The cache file is here now, and the download's copy reads as it is: no fetch said.
    onFetch.mockClear();
    await localEbook({ ...args, onFetch });
    mockTree.set(SAVED, 1234);
    await localEbook({ ...args, saved: SAVED, onFetch });
    expect(onFetch).not.toHaveBeenCalled();
  });

  it('keeps a copy of another length than the server’s size: it is the book, offline too', async () => {
    // The size is the server's last scan's; the route serves the file as it is now.
    mockDownload.mockImplementation(async () => 1234);
    await expect(localEbook(args)).resolves.toEqual({ uri: BOOK, size: 1234 });
    mockDownload.mockRejectedValue(new Error('The Internet connection appears to be offline.'));
    await expect(localEbook(args)).resolves.toEqual({ uri: BOOK, size: 1234 });
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('fetches the book again at a new size, and drops the old copy', async () => {
    await localEbook(args);
    mockDownload.mockImplementation(async () => 2000);
    await expect(localEbook({ ...args, size: 2000 })).resolves.toEqual({
      uri: `${FOLDER}/book-2000.epub`,
      size: 2000,
    });
    expect(mockDownload).toHaveBeenCalledTimes(2);
    expect(files()).toEqual([`${FOLDER}/book-2000.epub`]);
  });

  it('drops a part a fetch the app did not live to finish left behind', async () => {
    mockTree.set(FOLDER, 'dir');
    mockTree.set(`${FOLDER}/book-1000.epub.999999.part`, 300);
    await localEbook(args);
    expect(files()).toEqual([BOOK]);
  });

  it('gives two overlapping opens a part each, the first done leaving the other’s alone', async () => {
    const finish: ((bytes: number) => void)[] = [];
    mockDownload.mockImplementation(
      (_url, dest) =>
        new Promise<number>((resolve) => {
          mockTree.set(dest, 10); // a part grows where it is (Android)
          finish.push(resolve);
        }),
    );
    const first = localEbook(args);
    const second = localEbook(args);
    const [[, a], [, b]] = mockDownload.mock.calls;
    expect(a).toMatch(PART);
    expect(b).toMatch(PART);
    expect(a).not.toBe(b);
    finish[0](1000);
    await expect(first).resolves.toEqual({ uri: BOOK, size: 1000 });
    expect(mockTree.get(b)).toBe(10);
    finish[1](1000);
    await expect(second).resolves.toEqual({ uri: BOOK, size: 1000 });
    expect(files()).toEqual([BOOK]);
  });

  it('turns the server’s refusal into its status (404: the ebook is gone), leaving no file', async () => {
    mockDownload.mockRejectedValue(new Error('server returned HTTP 404'));
    const failed = await localEbook(args).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ApiError);
    expect((failed as ApiError).status).toBe(404);
    expect(mockDownload.mock.calls[0][1]).toMatch(PART);
    expect(files()).toEqual([]);
  });

  it('rejects an abort, leaving no part (Android writes the part as it goes)', async () => {
    const abort = new AbortController();
    const aborted = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    mockDownload.mockImplementation(async (_url, dest) => {
      mockTree.set(dest, 500);
      abort.abort();
      throw aborted;
    });
    await expect(localEbook({ ...args, signal: abort.signal })).rejects.toBe(aborted);
    expect(mockDownload.mock.calls[0][1]).toMatch(PART);
    expect(files()).toEqual([]);
  });

  it('passes on a network failure as it is', async () => {
    const offline = new Error('The Internet connection appears to be offline.');
    mockDownload.mockRejectedValue(offline);
    await expect(localEbook(args)).rejects.toBe(offline);
    expect(files()).toEqual([]);
  });

  it('refuses an empty download', async () => {
    mockDownload.mockImplementation(async () => 0);
    await expect(localEbook(args)).rejects.toThrow('empty');
    expect(files()).toEqual([]);
  });
});

describe('localEbook: size, disk and cache (fe#172)', () => {
  const MB = 1024 * 1024;

  it('refuses a book the server says is over the reader’s size, fetching nothing', async () => {
    const onFetch = jest.fn();
    const big = MAX_EBOOK_BYTES + 1;
    const err = await localEbook({ ...args, size: big, onFetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EbookTooLargeError);
    expect(mockDownload).not.toHaveBeenCalled();
    expect(onFetch).not.toHaveBeenCalled();
  });

  it('refuses a downloaded copy over the reader’s size, by its own length', async () => {
    mockTree.set(SAVED, MAX_EBOOK_BYTES + 1);
    await expect(localEbook({ ...args, saved: SAVED })).rejects.toBeInstanceOf(EbookTooLargeError);
    expect(mockDownload).not.toHaveBeenCalled();
    // The server's size names nothing here: a copy at the reader's size still opens.
    mockTree.set(SAVED, MAX_EBOOK_BYTES);
    await expect(localEbook({ ...args, saved: SAVED })).resolves.toEqual({
      uri: SAVED,
      size: MAX_EBOOK_BYTES,
    });
  });

  it('drops a fetched copy that came in over the reader’s size', async () => {
    mockDownload.mockImplementation(async () => MAX_EBOOK_BYTES + 1);
    await expect(localEbook(args)).rejects.toBeInstanceOf(EbookTooLargeError);
    expect(files()).toEqual([]);
  });

  it('says a device with no room before fetching', async () => {
    mockFree = 999;
    await expect(localEbook(args)).rejects.toBeInstanceOf(EbookStorageError);
    expect(mockDownload).not.toHaveBeenCalled();
    // Room for it: fetched.
    mockFree = 1000;
    await expect(localEbook(args)).resolves.toEqual({ uri: BOOK, size: 1000 });
  });

  it('says a disk that filled up while fetching, leaving no part', async () => {
    mockDownload.mockImplementation(async (_url, dest) => {
      mockTree.set(dest, 500);
      throw new Error('No space left on device');
    });
    await expect(localEbook(args)).rejects.toBeInstanceOf(EbookStorageError);
    expect(files()).toEqual([]);
  });

  it('says a cache that could not take the copy, leaving no part', async () => {
    mockMoveFails = true;
    await expect(localEbook(args)).rejects.toBeInstanceOf(EbookStorageError);
    expect(files()).toEqual([]);
  });

  it('holds the cache to its limit, dropping the copies fetched longest ago', async () => {
    const other = (n: number) => `file:///cache/reader/c2/1/${pathSlug(`B/${n}`)}/book-1.epub`;
    // Three other books, 200 MB each, fetched at 1, 2 and 3; this one adds 200 MB more.
    for (const n of [1, 2, 3]) {
      mockTree.set(other(n), 200 * MB);
      mockTimes.set(other(n), n);
    }
    mockDownload.mockImplementation(async () => 200 * MB);
    await localEbook({ ...args, size: 200 * MB });
    const book = `${FOLDER}/book-${200 * MB}.epub`;
    // 800 MB over a 512 MB limit: the two oldest go, the newest and this book stay.
    expect(READER_CACHE_MAX_BYTES).toBe(512 * MB);
    expect(files().sort()).toEqual([book, other(3)].sort());
  });

  it('keeps the book just fetched even when it alone fills the cache', async () => {
    const old = `file:///cache/reader/c1/2/${pathSlug('Old')}/book-1.epub`;
    mockTree.set(old, MB);
    mockTimes.set(old, 1);
    mockDownload.mockImplementation(async () => MAX_EBOOK_BYTES);
    await localEbook({ ...args, size: MAX_EBOOK_BYTES });
    expect(files()).toEqual([`${FOLDER}/book-${MAX_EBOOK_BYTES}.epub`]);
  });
});

describe('hasLocalEbook', () => {
  const ref = { connectionId: 'c1', libraryId: 2, path: 'A/Book' };

  it('finds the download’s copy, fetching nothing', async () => {
    mockTree.set('file:///docs/downloads/b/book.epub', 1234);
    await expect(
      hasLocalEbook({ ...ref, saved: 'file:///docs/downloads/b/book.epub' }),
    ).resolves.toBe(true);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('finds the cache file at the ebook’s size, and only at that size', async () => {
    await localEbook(args);
    await expect(hasLocalEbook({ ...ref, size: 1000 })).resolves.toBe(true);
    await expect(hasLocalEbook({ ...ref, size: 2000 })).resolves.toBe(false);
    await expect(hasLocalEbook(ref)).resolves.toBe(false);
  });

  it('says no for a gone or empty copy and nothing cached', async () => {
    mockTree.set('file:///docs/downloads/b/book.epub', 0);
    await expect(
      hasLocalEbook({ ...ref, size: 1000, saved: 'file:///docs/downloads/b/book.epub' }),
    ).resolves.toBe(false);
    await expect(
      hasLocalEbook({ ...ref, size: 1000, saved: 'file:///docs/gone/book.epub' }),
    ).resolves.toBe(false);
  });
});

describe('cachedEbookUri', () => {
  const ref = { connectionId: 'c1', libraryId: 2, path: 'A/Book' };

  it("names the reader's cache file at the ebook's size, for a download to copy", async () => {
    await localEbook(args);
    await expect(cachedEbookUri({ ...ref, size: 1000 })).resolves.toBe(BOOK);
  });

  it('has none at another size, an empty copy, or with no size', async () => {
    await localEbook(args);
    await expect(cachedEbookUri({ ...ref, size: 2000 })).resolves.toBeNull();
    await expect(cachedEbookUri(ref)).resolves.toBeNull();
    mockTree.set(BOOK, 0);
    await expect(cachedEbookUri({ ...ref, size: 1000 })).resolves.toBeNull();
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
    expect(files()).toHaveLength(1);
    expect(files()[0]).toMatch(/\/reader\/c2\//);
  });
});
