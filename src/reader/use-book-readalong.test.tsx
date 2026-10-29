import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Book } from '@/api/types';

// The server's flag, its map (the hooks' own tests) and the download's copy (the store's).
let mockServes: boolean | undefined = true;
const mockServerMap = jest.fn();
jest.mock('@/api/hooks', () => ({
  qk: { readalongLocal: (...key: unknown[]) => ['readalongLocal', ...key] },
  useCapability: () => mockServes,
  useReadalong: (_lib: number, _path: string, opts: { enabled: boolean }) => mockServerMap(opts),
}));
let mockKept: string | undefined;
const mockReadKept = jest.fn();
jest.mock('@/downloads/store', () => ({
  useDownloadedReadalong: () => mockKept,
  readDownloadedReadalong: (ref: unknown) => mockReadKept(ref),
}));

/* eslint-disable import/first */
import { readalongSource, useBookReadalong } from './use-book-readalong';
/* eslint-enable import/first */

const SPAN = { cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)', start: 1, end: 2 };
const map = (spans = [SPAN]) => ({
  format: 'audiosilo-readalong/v1',
  sections: [{ href: 'c1.xhtml', spans }],
  dropped: 0,
});
const EBOOK = { path: 'A/Book/a.epub', size: 9 };
const ready = (generated_at = 'g1'): Pick<Book, 'ebook' | 'readalong'> => ({
  ebook: EBOOK,
  readalong: { state: 'ready', generated_at },
});
const REF = { connectionId: 'c1', libraryId: 1, path: 'A/Book' };

describe('readalongSource', () => {
  const base = { serves: true as boolean | undefined, readable: true, kept: undefined };

  it("reads the server's ready map", () => {
    expect(readalongSource({ ...base, book: ready() })).toBe('server');
  });

  it('reads nothing for a stale or absent map, a book that does not read, or a server without maps', () => {
    const stale = { ebook: EBOOK, readalong: { state: 'stale', reason: 'ebook_changed' } };
    expect(readalongSource({ ...base, book: stale })).toBeNull();
    expect(readalongSource({ ...base, book: { ebook: EBOOK } })).toBeNull();
    expect(readalongSource({ ...base, book: ready(), readable: false })).toBeNull();
    expect(readalongSource({ ...base, book: ready(), serves: false })).toBeNull();
    // A stale map is invisible even with a copy on the device.
    expect(readalongSource({ ...base, book: stale, kept: 'g1' })).toBeNull();
  });

  it("reads the download's copy offline, the capability unknown", () => {
    expect(
      readalongSource({ ...base, serves: undefined, book: { ebook: EBOOK }, kept: 'g1' }),
    ).toBe('local');
  });

  it("reads the copy while the server's book names it or no map (a list row), else the server's", () => {
    expect(readalongSource({ ...base, book: ready('g1'), kept: 'g1' })).toBe('local');
    expect(readalongSource({ ...base, book: { ebook: EBOOK }, kept: 'g1' })).toBe('local');
    // Made again: the server's, while the refresh fetches it into the download.
    expect(readalongSource({ ...base, book: ready('g2'), kept: 'g1' })).toBe('server');
  });
});

describe('useBookReadalong', () => {
  let client: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    jest.clearAllMocks();
    mockServes = true;
    mockKept = undefined;
    mockServerMap.mockImplementation(({ enabled }: { enabled: boolean }) => ({
      data: enabled ? map() : undefined,
      isError: false,
    }));
  });

  it("hands the server's map to the reader, its sections and spans only", async () => {
    const { result } = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
    expect(result.current).toEqual({
      map: { sections: [{ href: 'c1.xhtml', spans: [SPAN] }] },
      pending: false,
    });
    expect(mockReadKept).not.toHaveBeenCalled();
  });

  it('reads the copy on the device offline, asking the server nothing', async () => {
    mockServes = undefined;
    mockKept = 'g1';
    mockReadKept.mockResolvedValue(map());
    const { result } = await renderHook(() => useBookReadalong(REF, { ebook: EBOOK }, true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.map).not.toBeNull());
    expect(mockReadKept).toHaveBeenCalledWith(REF);
    expect(mockServerMap).not.toHaveBeenCalledWith({ enabled: true, generatedAt: '' });
  });

  it("falls back to the server's map when the copy can't be read", async () => {
    mockKept = 'g1';
    mockReadKept.mockResolvedValue(null);
    const { result } = await renderHook(() => useBookReadalong(REF, ready('g1'), true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.map).not.toBeNull());
    expect(mockServerMap).toHaveBeenLastCalledWith({ enabled: true, generatedAt: 'g1' });
  });

  it('has nothing to follow in a map with no sentence', async () => {
    mockServerMap.mockReturnValue({ data: map([]), isError: false });
    const { result } = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
    expect(result.current).toEqual({ map: null, pending: false });
  });

  it('is pending while the map is on its way, and not once it failed', async () => {
    mockServerMap.mockReturnValue({ data: undefined, isError: false });
    const pending = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
    expect(pending.result.current.pending).toBe(true);
    mockServerMap.mockReturnValue({ data: undefined, isError: true });
    const failed = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
    expect(failed.result.current).toEqual({ map: null, pending: false });
  });
});
