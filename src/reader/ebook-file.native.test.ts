// The app's EPUB source (Bridge Phase 3b-2): the download's copy first, else the reader's
// cache file `book-<size>.epub`, named by the server's size and the book while it is there,
// fetched with the Authorization header to a part of its own; dropped with its connection.

import type { ApiClient } from '@/api/client';
import { pathSlug } from '@/lib/path-slug';

// An in-memory file tree standing in for expo-file-system: uri -> size (a file) or 'dir'.
const mockTree = new Map<string, number | 'dir'>();
type MockOptions = { headers?: Record<string, string>; signal?: AbortSignal; sessionType?: string };
const mockDownload = jest.fn(async (_url: string, _dest: string, _opts: MockOptions) => 1000);
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
    get size() {
      const v = mockTree.get(this.uri);
      return typeof v === 'number' ? v : null;
    }
    delete() {
      if (!this.exists) throw new Error(`nothing at ${this.uri}`);
      mockTree.delete(this.uri);
    }
    // Like the native move: a file already at the destination is an error without `overwrite`.
    async move(to: MockFile, opts?: { overwrite?: boolean }) {
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
    // The folder's own entries (a book's folder holds files only).
    list() {
      return [...mockTree.keys()]
        .filter((k) => k.startsWith(`${this.uri}/`) && !k.slice(this.uri.length + 1).includes('/'))
        .map((k) => new MockFile(k));
    }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { cache: 'file:///cache' } };
});
const mockRead = jest.fn(async (_uri: string, _o: unknown) => 'QUJD');
jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: (uri: string, o: unknown) => mockRead(uri, o),
}));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';

import { chunkReader, clearEbookCache, localEbook } from './ebook-file.native';
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
  jest.clearAllMocks();
  mockDownload.mockImplementation(async () => 1000);
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
