// An in-memory stand-in for expo-file-system's File/Directory API (the calls car-artwork
// makes), so the write-once, `.part` and prune rules are tested without a device.
const mockFiles = new Map<string, number>(); // uri -> size
const mockDownloadedTo: string[] = [];
const mockDownload = jest.fn(async (_url: string, to: { uri: string }) => {
  mockDownloadedTo.push(to.uri);
  mockFiles.set(to.uri, 1234);
});
jest.mock('expo-file-system', () => {
  const join = (parts: unknown[]) =>
    parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/');
  class MockFile {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    get size() {
      return mockFiles.get(this.uri) ?? null;
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }
    delete() {
      mockFiles.delete(this.uri);
    }
    copy(to: MockFile) {
      mockFiles.set(to.uri, mockFiles.get(this.uri) ?? 0);
    }
    move(to: MockFile) {
      mockFiles.set(to.uri, mockFiles.get(this.uri) ?? 0);
      mockFiles.delete(this.uri);
      this.uri = to.uri;
    }
    static downloadFileAsync = (url: string, to: MockFile) => mockDownload(url, to);
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    get exists() {
      return true;
    }
    create() {}
    list() {
      return [...mockFiles.keys()]
        .filter((u) => u.startsWith(`${this.uri}/`))
        .map((u) => new MockFile(u));
    }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { document: 'file:///docs' } };
});

/* eslint-disable import/first */
import { artworkName, ensureArtwork, existingArtwork, pruneArtwork } from './car-artwork';
/* eslint-enable import/first */

const DIR = 'file:///docs/car-artwork';

beforeEach(() => {
  mockFiles.clear();
  mockDownload.mockClear();
  mockDownloadedTo.length = 0;
});

describe('artworkName', () => {
  it('is stable, a JPEG name, and changes with the book and with its cover version', () => {
    const a = artworkName('c1:2:A/Book.m4b', 'v1');
    expect(a).toMatch(/^[0-9a-f]{16}\.jpg$/);
    expect(artworkName('c1:2:A/Book.m4b', 'v1')).toBe(a);
    expect(artworkName('c1:2:A/Book.m4b', 'v2')).not.toBe(a);
    expect(artworkName('c2:2:A/Book.m4b', 'v1')).not.toBe(a);
    expect(artworkName('c1:2:A/Book.m4b')).not.toBe(a);
  });
});

describe('ensureArtwork', () => {
  it('downloads a cover once, through a .part file, and reuses it after', async () => {
    const uri = await ensureArtwork('a.jpg', { url: 'https://srv/cover?size=320' });
    expect(uri).toBe(`${DIR}/a.jpg`);
    expect(mockDownload).toHaveBeenCalledWith('https://srv/cover?size=320', expect.anything());
    expect(mockDownloadedTo).toEqual([`${DIR}/a.jpg.part`]);
    expect([...mockFiles.keys()]).toEqual([`${DIR}/a.jpg`]);

    expect(await ensureArtwork('a.jpg', { url: 'https://srv/cover?size=320' })).toBe(uri);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(existingArtwork('a.jpg')).toBe(uri);
  });

  it('shares one download between two callers', async () => {
    const [x, y] = await Promise.all([
      ensureArtwork('b.jpg', { url: 'u' }),
      ensureArtwork('b.jpg', { url: 'u' }),
    ]);
    expect(x).toBe(y);
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('copies a downloaded book’s own cover without the network', async () => {
    mockFiles.set('file:///docs/downloads/c1/2/book/cover.jpg', 99);
    const uri = await ensureArtwork('c.jpg', {
      localUri: 'file:///docs/downloads/c1/2/book/cover.jpg',
    });
    expect(uri).toBe(`${DIR}/c.jpg`);
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockFiles.has('file:///docs/downloads/c1/2/book/cover.jpg')).toBe(true);
  });

  it('writes nothing that counts as a cover when the fetch fails (offline)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDownload.mockRejectedValueOnce(new Error('offline'));
    expect(await ensureArtwork('d.jpg', { url: 'u' })).toBeNull();
    expect(existingArtwork('d.jpg')).toBeNull();
    // An empty answer is no cover either.
    mockDownload.mockImplementationOnce(async (_u, to) => {
      mockFiles.set(to.uri, 0);
    });
    expect(await ensureArtwork('d.jpg', { url: 'u' })).toBeNull();
    expect(mockFiles.size).toBe(0);
    warn.mockRestore();
  });
});

describe('pruneArtwork', () => {
  it('deletes the covers no snapshot names, and leftover .part files', () => {
    mockFiles.set(`${DIR}/keep.jpg`, 1);
    mockFiles.set(`${DIR}/old.jpg`, 1);
    mockFiles.set(`${DIR}/stale.jpg.part`, 1);
    mockFiles.set('file:///docs/downloads/x.mp3', 1);
    pruneArtwork(new Set(['keep.jpg']));
    expect([...mockFiles.keys()].sort()).toEqual([
      `${DIR}/keep.jpg`,
      'file:///docs/downloads/x.mp3',
    ]);
  });
});
