// An in-memory stand-in for expo-file-system's File/Directory API (the calls car-artwork
// makes), so the write-once, `.part` and prune rules are tested without a device.
const mockFiles = new Map<string, number>(); // uri -> size
const mockDownloadedTo: string[] = [];
const mockWrite = async (_url: string, to: { uri: string }) => {
  mockDownloadedTo.push(to.uri);
  mockFiles.set(to.uri, 1234);
};
const mockDownload = jest.fn(mockWrite);
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
import {
  artworkName,
  ensureArtwork,
  existingArtwork,
  MAX_RETRY_MS,
  pruneArtwork,
  RETRY_MS,
} from './car-artwork';
/* eslint-enable import/first */

const DIR = 'file:///docs/car-artwork';

beforeEach(() => {
  mockFiles.clear();
  mockDownload.mockReset();
  mockDownload.mockImplementation(mockWrite);
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
    const uri = await ensureArtwork('a.jpg', 'https://srv/cover?size=320');
    expect(uri).toBe(`${DIR}/a.jpg`);
    expect(mockDownload).toHaveBeenCalledWith('https://srv/cover?size=320', expect.anything());
    expect(mockDownloadedTo).toEqual([`${DIR}/a.jpg.part`]);
    expect([...mockFiles.keys()]).toEqual([`${DIR}/a.jpg`]);

    expect(await ensureArtwork('a.jpg', 'https://srv/cover?size=320')).toBe(uri);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(existingArtwork('a.jpg')).toBe(uri);
  });

  it('shares one download between two callers', async () => {
    const [x, y] = await Promise.all([ensureArtwork('b.jpg', 'u'), ensureArtwork('b.jpg', 'u')]);
    expect(x).toBe(y);
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('writes nothing that counts as a cover when the fetch fails (offline)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDownload.mockRejectedValueOnce(new Error('offline'));
    expect(await ensureArtwork('d.jpg', 'u')).toBeNull();
    expect(existingArtwork('d.jpg')).toBeNull();
    // An empty answer is no cover either.
    mockDownload.mockImplementationOnce(async (_u, to) => {
      mockFiles.set(to.uri, 0);
    });
    expect(await ensureArtwork('d2.jpg', 'u')).toBeNull();
    expect(mockFiles.size).toBe(0);
    warn.mockRestore();
  });

  describe('a cover that failed', () => {
    const t0 = new Date('2026-10-08T12:00:00Z').getTime();
    let warn: jest.SpyInstance;
    beforeEach(() => {
      jest.useFakeTimers({ now: t0 });
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
      jest.useRealTimers();
    });

    // Regression: every snapshot write asked the server again for each cover it lacked, so a
    // library whose covers 404 logged a warning per book per write (20 per write on the
    // device fixture).
    it('is not asked again this session when the server has none (404), and warns once', async () => {
      mockDownload.mockRejectedValue(
        new Error('Unable to download a file: response has status: 404'),
      );
      expect(await ensureArtwork('n.jpg', 'u')).toBeNull();
      jest.setSystemTime(t0 + 24 * 3600_000);
      for (let i = 0; i < 5; i++) expect(await ensureArtwork('n.jpg', 'u')).toBeNull();
      expect(mockDownload).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      // iOS words it without the colon; a new cover version is a new name, asked at once.
      mockDownload.mockRejectedValue(new Error('response has status 404'));
      expect(await ensureArtwork('n-v2.jpg', 'u')).toBeNull();
      expect(await ensureArtwork('n-v2.jpg', 'u')).toBeNull();
      expect(mockDownload).toHaveBeenCalledTimes(2);
    });

    it('backs off any other failure (offline, 5xx), doubling, then writes it once it can', async () => {
      mockDownload.mockRejectedValueOnce(new Error('offline'));
      expect(await ensureArtwork('o.jpg', 'u')).toBeNull();
      expect(await ensureArtwork('o.jpg', 'u')).toBeNull();
      expect(mockDownload).toHaveBeenCalledTimes(1);

      jest.setSystemTime(t0 + RETRY_MS);
      mockDownload.mockRejectedValueOnce(new Error('response has status: 503'));
      expect(await ensureArtwork('o.jpg', 'u')).toBeNull();
      expect(mockDownload).toHaveBeenCalledTimes(2);
      // The second failure waits twice as long.
      jest.setSystemTime(t0 + RETRY_MS + RETRY_MS);
      expect(await ensureArtwork('o.jpg', 'u')).toBeNull();
      expect(mockDownload).toHaveBeenCalledTimes(2);
      jest.setSystemTime(t0 + RETRY_MS + 2 * RETRY_MS);
      expect(await ensureArtwork('o.jpg', 'u')).toBe(`${DIR}/o.jpg`);
      expect(mockDownload).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('never waits longer than MAX_RETRY_MS between tries', async () => {
      mockDownload.mockRejectedValue(new Error('offline'));
      let now = t0;
      for (let i = 0; i < 10; i++) {
        await ensureArtwork('m.jpg', 'u');
        now += MAX_RETRY_MS;
        jest.setSystemTime(now);
      }
      expect(mockDownload).toHaveBeenCalledTimes(10);
    });
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
