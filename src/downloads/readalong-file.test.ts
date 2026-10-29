import type { ApiClient } from '@/api/client';

// The download's read-along map: fetched beside book.epub, checked on read, and which map a
// server's answer asks for. The engine is a stand-in (its own tests cover the platforms).
const mockEngine = {
  downloadFile: jest.fn(),
  readText: jest.fn(),
  removeFile: jest.fn(async () => {}),
};
jest.mock('@/downloads/engine', () => ({
  get engine() {
    return mockEngine;
  },
}));

/* eslint-disable import/first */
import {
  fetchReadalongFile,
  READALONG_FILE,
  readalongChange,
  readReadalongFile,
  removeReadalongFile,
  wantsReadalong,
} from './readalong-file';
/* eslint-enable import/first */

const REF = { connectionId: 'c1', libraryId: 2, path: 'A/Book' };
const SPAN = { cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)', start: 1, end: 2 };
const MAP = {
  format: 'audiosilo-readalong/v1',
  generated_at: '2026-11-02T10:11:12Z',
  sections: [{ href: 'c1.xhtml', spans: [SPAN] }],
};
const API = {
  readalongRequest: (lib: number, path: string) => ({
    url: `https://h/api/v1/libraries/${lib}/readalong?path=${path}`,
    headers: { Authorization: 'Bearer t' },
  }),
} as unknown as ApiClient;

beforeEach(() => {
  jest.clearAllMocks();
  mockEngine.downloadFile.mockResolvedValue('file:///d/A/Book/readalong.json');
  mockEngine.readText.mockResolvedValue(JSON.stringify(MAP));
});

describe('fetchReadalongFile', () => {
  it('fetches the map with the header beside the EPUB and names which one it is', async () => {
    const signal = new AbortController().signal;
    await expect(fetchReadalongFile(API, REF, signal)).resolves.toEqual({
      uri: 'file:///d/A/Book/readalong.json',
      generatedAt: MAP.generated_at,
    });
    expect(mockEngine.downloadFile).toHaveBeenCalledWith(
      'c1',
      2,
      'A/Book',
      READALONG_FILE,
      'https://h/api/v1/libraries/2/readalong?path=A/Book',
      undefined,
      signal,
      { Authorization: 'Bearer t' },
    );
    expect(mockEngine.removeFile).not.toHaveBeenCalled();
  });

  it.each([
    ['no map', 'not json'],
    ['another format', JSON.stringify({ ...MAP, format: 'audiosilo-readalong/v2' })],
    ['no generated_at', JSON.stringify({ ...MAP, generated_at: undefined })],
    ['no sentence', JSON.stringify({ ...MAP, sections: [{ href: 'c1.xhtml', spans: [] }] })],
  ])('keeps nothing when what landed is %s', async (_, text) => {
    mockEngine.readText.mockResolvedValue(text);
    await expect(fetchReadalongFile(API, REF)).resolves.toBeUndefined();
    expect(mockEngine.removeFile).toHaveBeenCalledWith('c1', 2, 'A/Book', READALONG_FILE);
  });

  it('is none, not a failure, when the server refuses it', async () => {
    mockEngine.downloadFile.mockRejectedValue(new Error('HTTP 404'));
    await expect(fetchReadalongFile(API, REF)).resolves.toBeUndefined();
    expect(mockEngine.removeFile).toHaveBeenCalled();
  });

  it('throws a cancel, so the download stops', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    mockEngine.downloadFile.mockRejectedValue(new Error('aborted'));
    await expect(fetchReadalongFile(API, REF, ctrl.signal)).rejects.toThrow('aborted');
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
  });
  const ready = (g: string) => ({ readalong: { state: 'ready' as const, generated_at: g } });

  it('keeps the same map, fetches one made again or not yet kept', () => {
    expect(readalongChange(ready('g1'), kept('g1'))).toBe('keep');
    expect(readalongChange(ready('g2'), kept('g1'))).toBe('fetch');
    expect(readalongChange(ready('g1'), kept())).toBe('fetch');
  });

  it('drops a kept map once the server has none ready', () => {
    expect(readalongChange({}, kept('g1'))).toBe('drop');
    expect(
      readalongChange({ readalong: { state: 'stale', reason: 'ebook_changed' } }, kept('g1')),
    ).toBe('drop');
    expect(readalongChange({}, kept())).toBe('keep');
  });

  it('does nothing without the EPUB on the device', () => {
    expect(readalongChange(ready('g2'), { readalongGeneratedAt: 'g1' })).toBe('keep');
  });
});
