import type { ApiClient } from '@/api/client';

// The download's read-along map: fetched beside book.epub, checked on read, and which map a
// server's answer asks for. The engine is a stand-in (its own tests cover the platforms).
const mockEngine = {
  writeText: jest.fn(),
  readText: jest.fn(),
  removeFile: jest.fn(async () => {}),
};
jest.mock('@/downloads/engine', () => ({
  get engine() {
    return mockEngine;
  },
}));

/* eslint-disable import/first */
import { parseReadalongMap } from '@/reader/readalong-map';

import {
  fetchReadalongFile,
  fitsEbook,
  READALONG_FILE,
  readalongChange,
  readReadalongFile,
  removeReadalongFile,
  wantsReadalong,
} from './readalong-file';
/* eslint-enable import/first */

const REF = { connectionId: 'c1', libraryId: 2, path: 'A/Book' };
const SPAN = { cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)', start: 1, end: 2 };
const SHA = 'a'.repeat(64);
const MAP = {
  format: 'audiosilo-readalong/v1',
  ebook: { file: 'a.epub', sha256: SHA },
  generated_at: '2026-11-02T10:11:12Z',
  sections: [{ href: 'c1.xhtml', spans: [SPAN] }],
};
const mockReadalong = jest.fn();
const API = { readalong: mockReadalong } as unknown as ApiClient;
/** The server's answer as `client.readalong` resolves it: checked. */
const checked = (raw: unknown) => parseReadalongMap(raw);

beforeEach(() => {
  jest.clearAllMocks();
  mockReadalong.mockImplementation(async () => checked(MAP));
  mockEngine.writeText.mockResolvedValue(true);
  mockEngine.readText.mockResolvedValue(JSON.stringify(MAP));
});

describe('fetchReadalongFile', () => {
  it('fetches the map, keeps it beside the EPUB and names which one it is', async () => {
    const signal = new AbortController().signal;
    const kept = await fetchReadalongFile(API, REF, { signal });
    expect(kept).toEqual({
      generatedAt: MAP.generated_at,
      ebookSha256: SHA,
      bytes: (mockEngine.writeText.mock.calls[0][4] as string).length,
    });
    expect(mockReadalong).toHaveBeenCalledWith(2, 'A/Book', signal);
    expect(mockEngine.writeText).toHaveBeenCalledWith(
      'c1',
      2,
      'A/Book',
      READALONG_FILE,
      expect.any(String),
    );
    // What is saved reads back as the same map.
    const saved = JSON.parse(mockEngine.writeText.mock.calls[0][4] as string);
    expect(parseReadalongMap(saved)).toEqual(checked(MAP));
    expect(mockEngine.removeFile).not.toHaveBeenCalled();
  });

  it.each([
    ['no generated_at', { ...MAP, generated_at: undefined }],
    ['no sentence', { ...MAP, sections: [{ href: 'c1.xhtml', spans: [] }] }],
  ])('keeps nothing when the map has %s', async (_, raw) => {
    mockReadalong.mockImplementation(async () => checked(raw));
    await expect(fetchReadalongFile(API, REF)).resolves.toBeUndefined();
    expect(mockEngine.writeText).not.toHaveBeenCalled();
  });

  it('is none, not a failure, when the fetch fails, and never touches a map already kept', async () => {
    mockReadalong.mockRejectedValue(new Error('HTTP 404'));
    await expect(fetchReadalongFile(API, REF)).resolves.toBeUndefined();
    mockReadalong.mockRejectedValue(new TypeError('Network request failed'));
    await expect(fetchReadalongFile(API, REF)).resolves.toBeUndefined();
    expect(mockEngine.writeText).not.toHaveBeenCalled();
    expect(mockEngine.removeFile).not.toHaveBeenCalled();
  });

  it('is none when the folder is gone (nothing written)', async () => {
    mockEngine.writeText.mockResolvedValue(false);
    await expect(fetchReadalongFile(API, REF)).resolves.toBeUndefined();
  });

  it('throws a cancel, so the download stops', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    mockReadalong.mockRejectedValue(new Error('aborted'));
    await expect(fetchReadalongFile(API, REF, { signal: ctrl.signal })).rejects.toThrow('aborted');
  });

  it("refuses a map made from another ebook than the download's (fe#193), keeping the one kept", async () => {
    await expect(
      fetchReadalongFile(API, REF, { ebookSha256: 'b'.repeat(64) }),
    ).resolves.toBeUndefined();
    expect(mockEngine.writeText).not.toHaveBeenCalled();
    expect(mockEngine.removeFile).not.toHaveBeenCalled();
    // A map that names no ebook never fits a known one.
    mockReadalong.mockImplementation(async () => checked({ ...MAP, ebook: undefined }));
    await expect(fetchReadalongFile(API, REF, { ebookSha256: SHA })).resolves.toBeUndefined();
    // The same ebook's map is kept.
    mockReadalong.mockImplementation(async () => checked(MAP));
    await expect(fetchReadalongFile(API, REF, { ebookSha256: SHA })).resolves.toMatchObject({
      generatedAt: MAP.generated_at,
    });
  });

  it('counts the bytes the map takes on the device, in UTF-8', async () => {
    mockReadalong.mockImplementation(async () =>
      checked({ ...MAP, sections: [{ href: 'é€😀.xhtml', spans: [SPAN] }] }),
    );
    const kept = await fetchReadalongFile(API, REF);
    const text = mockEngine.writeText.mock.calls[0][4] as string;
    expect(kept?.bytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(kept?.bytes).toBeGreaterThan(text.length);
  });
});

describe('readReadalongFile / removeReadalongFile', () => {
  it("reads the folder's map, checked, and null for none or junk", async () => {
    await expect(readReadalongFile(REF)).resolves.toMatchObject({
      generated_at: MAP.generated_at,
      sections: [{ href: 'c1.xhtml', spans: [SPAN] }],
    });
    expect(mockEngine.readText).toHaveBeenCalledWith('c1', 2, 'A/Book', READALONG_FILE);
    mockEngine.readText.mockResolvedValue(null);
    await expect(readReadalongFile(REF)).resolves.toBeNull();
    mockEngine.readText.mockResolvedValue('{');
    await expect(readReadalongFile(REF)).resolves.toBeNull();
  });

  it('drops the file, best effort', async () => {
    mockEngine.removeFile.mockRejectedValueOnce(new Error('gone'));
    await expect(removeReadalongFile(REF)).resolves.toBeUndefined();
  });
});

describe('fitsEbook', () => {
  it('fits any map while the ebook is not known, else only its own', () => {
    expect(fitsEbook({ ebook: { file: '', sha256: 'x' } }, undefined)).toBe(true);
    expect(fitsEbook({ ebook: { file: '', sha256: 'x' } }, 'x')).toBe(true);
    expect(fitsEbook({ ebook: { file: '', sha256: 'y' } }, 'x')).toBe(false);
    expect(fitsEbook({ ebook: { file: '', sha256: '' } }, 'x')).toBe(false);
  });
});

describe('wantsReadalong', () => {
  it('asks only with the EPUB kept, a server that serves maps and no known-stale map', () => {
    const ready = { readalong: { state: 'ready' as const, generated_at: 'g1' } };
    expect(wantsReadalong(true, ready, 'book.epub')).toBe(true);
    expect(wantsReadalong(true, {}, 'book.epub')).toBe(true);
    expect(wantsReadalong(true, ready, undefined)).toBe(false);
    expect(wantsReadalong(false, ready, 'book.epub')).toBe(false);
    expect(wantsReadalong(undefined, ready, 'book.epub')).toBe(false);
    expect(
      wantsReadalong(true, { readalong: { state: 'stale', reason: 'audio_changed' } }, 'e'),
    ).toBe(false);
  });
});

describe('readalongChange', () => {
  const kept = (generatedAt?: string) => ({
    ebookUri: 'book.epub',
    readalongGeneratedAt: generatedAt,
    book: {},
  });
  const ready = (g: string) => ({ readalong: { state: 'ready' as const, generated_at: g } });

  it('keeps the same map, fetches one made again or not yet kept', () => {
    expect(readalongChange(ready('g1'), kept('g1'))).toBe('keep');
    expect(readalongChange(ready('g2'), kept('g1'))).toBe('fetch');
    expect(readalongChange(ready('g1'), kept())).toBe('fetch');
  });

  it('drops a kept map once the server has none ready', () => {
    expect(readalongChange({}, kept('g1'))).toBe('drop');
    expect(readalongChange({}, { ...kept('g1'), ebookSha256: SHA })).toBe('drop');
    expect(readalongChange({}, kept())).toBe('keep');
  });

  it("keeps a stale map while it fits the download's own EPUB (fe#193)", () => {
    const stale = { state: 'stale' as const, reason: 'ebook_changed' as const };
    const other = { readalong: stale, ebook: { path: 'A/B.epub', size: 9 } };
    // Its sha known: every map it kept was checked against it.
    expect(readalongChange(other, { ...kept('g1'), ebookSha256: SHA })).toBe('keep');
    // No sha: while the server's ebook keeps the size the download saved.
    expect(readalongChange({ readalong: stale }, kept('g1'))).toBe('keep');
    expect(readalongChange(other, kept('g1'))).toBe('drop');
  });

  it('does nothing without the EPUB on the device', () => {
    expect(readalongChange(ready('g2'), { readalongGeneratedAt: 'g1', book: {} })).toBe('keep');
  });
});
