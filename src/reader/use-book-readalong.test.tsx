import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Book } from '@/api/types';

// The server's flag, its map (the hooks' own tests) and the download's copy (the store's).
let mockServes: boolean | undefined = true;
const mockServerMap = jest.fn();
jest.mock('@/api/hooks', () => ({
  CapabilityError: class CapabilityError extends Error {},
  qk: {
    readalong: (...key: unknown[]) => ['readalong', ...key],
    readalongLocal: (...key: unknown[]) => ['readalongLocal', ...key],
  },
  useCapability: () => mockServes,
  useReadalong: (_lib: number, _path: string, opts: { enabled: boolean }) => mockServerMap(opts),
}));
let mockKept: string | undefined;
let mockEbookSha: string | undefined;
let mockEbookSize: number | undefined;
const mockReadKept = jest.fn();
jest.mock('@/downloads/store', () => ({
  useDownloadedReadalong: () => mockKept,
  useDownloadedEbookSha: () => mockEbookSha,
  useDownloadedEbookSize: () => mockEbookSize,
  readDownloadedReadalong: (ref: unknown) => mockReadKept(ref),
}));
let mockDeviceOnline = true;
jest.mock('@/lib/device-online', () => ({
  ...jest.requireActual('@/lib/device-online'),
  useDeviceOnline: () => mockDeviceOnline,
}));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';

import {
  readalongFailure,
  readalongNone,
  readalongSource,
  useBookReadalong,
} from './use-book-readalong';
/* eslint-enable import/first */

const SPAN = { cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)', start: 1, end: 2 };
const map = (spans = [SPAN], sha = 'sha-1') => ({
  format: 'audiosilo-readalong/v1',
  ebook: { file: 'a.epub', sha256: sha },
  sections: [{ href: 'c1.xhtml', spans }],
  dropped: 0,
});
const EBOOK = { path: 'A/Book/a.epub', size: 9 };
const ready = (generated_at = 'g1'): Pick<Book, 'ebook' | 'readalong'> => ({
  ebook: EBOOK,
  readalong: { state: 'ready', generated_at },
});
const REF = { connectionId: 'c1', libraryId: 1, path: 'A/Book' };
const SERVER_MAP = map();

describe('readalongSource', () => {
  const base = { serves: true as boolean | undefined, readable: true, kept: undefined };

  it("reads the server's ready map", () => {
    expect(readalongSource({ ...base, book: ready() })).toBe('server');
  });

  const stale = {
    ebook: EBOOK,
    readalong: { state: 'stale', reason: 'ebook_changed' },
  } as const satisfies Pick<Book, 'ebook' | 'readalong'>;

  it('reads nothing for a stale or absent map, a book that does not read, or a server without maps', () => {
    expect(readalongSource({ ...base, book: stale })).toBeNull();
    expect(readalongSource({ ...base, book: { ebook: EBOOK } })).toBeNull();
    expect(readalongSource({ ...base, book: ready(), readable: false })).toBeNull();
    expect(readalongSource({ ...base, book: ready(), serves: false })).toBeNull();
    expect(readalongSource({ ...base, book: stale, kept: 'g1', serves: false })).toBeNull();
  });

  it("reads the download's copy online when the server's map is stale (fe#202 D4)", () => {
    expect(readalongSource({ ...base, book: stale, kept: 'g1' })).toBe('local');
    expect(readalongSource({ ...base, book: stale, kept: 'g1', readable: false })).toBeNull();
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

describe('readalongNone', () => {
  it("is the server's none, never a failure to say", () => {
    expect(readalongNone(new ApiError(404, 'x', 'no_readalong'))).toBe(true);
    expect(readalongNone(new ApiError(409, 'x', 'readalong_stale'))).toBe(true);
    expect(readalongNone(new ApiError(500, 'x'))).toBe(false);
    expect(readalongNone(new TypeError('Network request failed'))).toBe(false);
  });
});

describe('readalongFailure', () => {
  it('tells a refusal Try again cannot mend from a failure to say', () => {
    expect(readalongFailure(new ApiError(404, 'x', 'no_readalong'))).toBeNull();
    expect(readalongFailure(new ApiError(409, 'x', 'readalong_stale'))).toBeNull();
    expect(readalongFailure(new ApiError(401, 'x'))).toBe('signedOut');
    expect(readalongFailure(new ApiError(403, 'x'))).toBe('denied');
    expect(readalongFailure(new ApiError(404, 'x'))).toBe('missing');
    expect(readalongFailure(new ApiError(503, 'x'))).toBe('retry');
    expect(readalongFailure(new TypeError('Network request failed'))).toBe('retry');
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
    mockEbookSha = undefined;
    mockEbookSize = undefined;
    mockDeviceOnline = true;
    // One answer per map, as the query gives it (the same object on every render).
    mockServerMap.mockImplementation(({ enabled }: { enabled: boolean }) => ({
      data: enabled ? SERVER_MAP : undefined,
      isError: false,
    }));
  });

  it("hands the server's map to the reader, its sections and spans only", async () => {
    const { result } = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
    expect(result.current).toMatchObject({
      map: { sections: [{ href: 'c1.xhtml', spans: [SPAN] }] },
      pending: false,
      failure: null,
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
    expect(
      client.getQueryCache().find({ queryKey: ['readalongLocal', 'c1', 1, 'A/Book', 'g1'] })?.meta,
    ).toEqual({ local: true });
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
    expect(result.current).toMatchObject({ map: null, pending: false });
  });

  it('is pending while the map is on its way, and not once it failed', async () => {
    mockServerMap.mockReturnValue({ data: undefined, isError: false });
    const pending = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
    expect(pending.result.current.pending).toBe(true);
    mockServerMap.mockReturnValue({ data: undefined, isError: true });
    const failed = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
    expect(failed.result.current).toMatchObject({ map: null, pending: false });
  });

  it('says a failed read failed (offline, a 5xx), with Try again reading it again', async () => {
    const refetch = jest.fn();
    mockServerMap.mockReturnValue({
      data: undefined,
      isError: true,
      error: new ApiError(503, 'down'),
      refetch,
    });
    const { result } = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
    expect(result.current).toMatchObject({ map: null, pending: false, failure: 'retry' });
    result.current.retry();
    expect(refetch).toHaveBeenCalled();
  });

  it("takes the server's none (404 no_readalong, 409 readalong_stale) as none, not a failure", async () => {
    for (const error of [
      new ApiError(404, 'none', 'no_readalong'),
      new ApiError(409, 'stale', 'readalong_stale'),
    ]) {
      mockServerMap.mockReturnValue({ data: undefined, isError: true, error, refetch: jest.fn() });
      const { result } = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
      expect(result.current).toMatchObject({ map: null, pending: false, failure: null });
    }
  });

  it("gives a device copy whose read threw way to the server's map when it is ready", async () => {
    mockKept = 'g1';
    mockReadKept.mockRejectedValue(new Error('EIO'));
    const { result } = await renderHook(() => useBookReadalong(REF, ready('g1'), true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.map).not.toBeNull());
    expect(result.current.failure).toBeNull();
  });

  it('is pending, never failed, while Try again reads the map again', async () => {
    mockServerMap.mockReturnValue({
      data: undefined,
      isError: true,
      isFetching: true,
      error: new ApiError(503, 'down'),
      refetch: jest.fn(),
    });
    const { result } = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
    expect(result.current).toMatchObject({ map: null, pending: true, failure: null });
  });

  it("says a copy on the device that won't read failed", async () => {
    mockServes = undefined;
    mockKept = 'g1';
    mockReadKept.mockRejectedValue(new Error('EIO'));
    const { result } = await renderHook(() => useBookReadalong(REF, { ebook: EBOOK }, true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.failure).toBe('retry'));
  });

  it('keeps the map shown while another copy of it is on its way, never past a stale one', async () => {
    const REMADE = map([{ ...SPAN, start: 3, end: 4 }]);
    let remadeIn = false;
    mockServerMap.mockImplementation(
      ({ enabled, generatedAt }: { enabled: boolean; generatedAt: string }) => ({
        data: !enabled
          ? undefined
          : generatedAt === 'g1'
            ? SERVER_MAP
            : remadeIn
              ? REMADE
              : undefined,
        isError: false,
      }),
    );
    const { result, rerender } = await renderHook(
      ({ book }: { book: Pick<Book, 'ebook' | 'readalong'> }) => useBookReadalong(REF, book, true),
      { wrapper, initialProps: { book: ready('g1') } },
    );
    const first = result.current.map;
    expect(first).not.toBeNull();
    // Made again: its map is on its way, the one shown stays.
    await rerender({ book: ready('g2') });
    expect(result.current).toMatchObject({ map: first, pending: false });
    remadeIn = true;
    await rerender({ book: ready('g2') });
    expect(result.current.map).toEqual({
      sections: [{ href: 'c1.xhtml', spans: [{ ...SPAN, start: 3, end: 4 }] }],
    });
    // Stale: nothing to follow, at once, and nothing kept for later.
    await rerender({ book: { ebook: EBOOK, readalong: { state: 'stale' } } });
    expect(result.current).toMatchObject({ map: null, pending: false });
    remadeIn = false;
    await rerender({ book: ready('g3') });
    expect(result.current).toMatchObject({ map: null, pending: true });
  });

  it('keeps the map shown while another copy of it waits for the connection', async () => {
    mockServerMap.mockImplementation(
      ({ enabled, generatedAt }: { enabled: boolean; generatedAt: string }) =>
        enabled && generatedAt === 'g1'
          ? { data: SERVER_MAP, isError: false }
          : { data: undefined, isError: false, fetchStatus: enabled ? 'paused' : 'idle' },
    );
    const { result, rerender } = await renderHook(
      ({ book }: { book: Pick<Book, 'ebook' | 'readalong'> }) => useBookReadalong(REF, book, true),
      { wrapper, initialProps: { book: ready('g1') } },
    );
    const first = result.current.map;
    expect(first).not.toBeNull();
    // Made again, and its map's fetch is held back by the connection: the one shown stays.
    await rerender({ book: ready('g2') });
    expect(result.current).toMatchObject({ map: first, pending: false, offline: false });
  });

  it('keeps no map of another book', async () => {
    mockServerMap.mockImplementation(
      ({ enabled, generatedAt }: { enabled: boolean; generatedAt: string }) => ({
        data: enabled && generatedAt === 'g1' ? SERVER_MAP : undefined,
        isError: false,
      }),
    );
    const { result, rerender } = await renderHook(
      ({ path, book }: { path: string; book: Pick<Book, 'ebook' | 'readalong'> }) =>
        useBookReadalong({ ...REF, path }, book, true),
      { wrapper, initialProps: { path: 'A/Book', book: ready('g1') } },
    );
    expect(result.current.map).not.toBeNull();
    await rerender({ path: 'B/Book', book: ready('g2') });
    expect(result.current).toMatchObject({ map: null, pending: true });
  });
  it.each([
    [401, 'signedOut'],
    [403, 'denied'],
    [404, 'missing'],
  ] as const)(
    'says a %s refusal as its own failure, not Try again (fe#192)',
    async (status, failure) => {
      mockServerMap.mockReturnValue({
        data: undefined,
        isError: true,
        error: new ApiError(status, 'no'),
        refetch: jest.fn(),
      });
      const { result } = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
      expect(result.current).toMatchObject({ map: null, pending: false, failure });
    },
  );

  it('is neither pending nor failed while the map waits for the connection (fe#192)', async () => {
    mockServerMap.mockReturnValue({ data: undefined, isError: false, fetchStatus: 'paused' });
    const { result } = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
    expect(result.current).toMatchObject({
      map: null,
      pending: false,
      failure: null,
      offline: true,
    });
  });

  // fe#142: a reload with no network sends the request before anything knows, so the read
  // fails instead of waiting. The Text tab then goes (`textTab`), no "couldn't load" with
  // a Try again that cannot work.
  it('is offline, not failed, when the read failed with no network on the device', async () => {
    mockDeviceOnline = false;
    mockServerMap.mockReturnValue({
      data: undefined,
      isError: true,
      error: new TypeError('Network request failed'),
    });
    const { result } = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
    expect(result.current).toMatchObject({
      map: null,
      pending: false,
      failure: null,
      offline: true,
    });
  });

  it('still says what the server said with no network on the device (a refusal)', async () => {
    mockDeviceOnline = false;
    mockServerMap.mockReturnValue({
      data: undefined,
      isError: true,
      error: new ApiError(403, 'no'),
    });
    const { result } = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
    expect(result.current).toMatchObject({ failure: 'denied', offline: false });
  });

  it("reads the device's copy with no network, its failure a failure to say", async () => {
    mockDeviceOnline = false;
    mockServes = undefined;
    mockKept = 'g1';
    mockReadKept.mockRejectedValue(new Error('disk'));
    const { result } = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
    await waitFor(() => expect(result.current.failure).toBe('retry'));
    expect(result.current.offline).toBe(false);
  });

  describe('a stale map online (fe#202 D4)', () => {
    const stale: Pick<Book, 'ebook' | 'readalong'> = {
      ebook: EBOOK,
      readalong: { state: 'stale', reason: 'ebook_changed' },
    };

    it("shows the download's kept map, asking the server nothing", async () => {
      mockKept = 'g1';
      mockReadKept.mockResolvedValue(map());
      const { result } = await renderHook(() => useBookReadalong(REF, stale, true), { wrapper });
      await waitFor(() => expect(result.current.map).not.toBeNull());
      expect(result.current.failure).toBeNull();
      expect(mockServerMap).not.toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    });

    it('shows nothing once it does not fit the EPUB actually opened', async () => {
      mockKept = 'g1';
      mockReadKept.mockResolvedValue(map([SPAN], 'sha-1'));
      const { result } = await renderHook(() => useBookReadalong(REF, stale, true), { wrapper });
      await waitFor(() => expect(result.current.map).not.toBeNull());
      await act(async () =>
        result.current.onEbook({ source: 'download', size: EBOOK.size, sha256: 'sha-9' }),
      );
      await waitFor(() => expect(result.current.map).toBeNull());
    });

    it("shows nothing with the server's EPUB opened instead (an unreadable download)", async () => {
      mockKept = 'g1';
      mockReadKept.mockResolvedValue(map());
      const { result } = await renderHook(() => useBookReadalong(REF, stale, true), { wrapper });
      await waitFor(() => expect(result.current.map).not.toBeNull());
      await act(async () =>
        result.current.onEbook({ source: 'server', size: EBOOK.size, sha256: 'sha-1' }),
      );
      await waitFor(() => expect(result.current).toMatchObject({ map: null, failure: null }));
    });
  });

  describe('a map read once per book, not per open (fe#202)', () => {
    beforeEach(() => {
      // Unwatched queries leave the cache at once: only the pin keeps one.
      client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
    });

    it("keeps the copy read while no surface shows it, until another book's map is read", async () => {
      mockServes = undefined;
      mockKept = 'g1';
      mockReadKept.mockResolvedValue(map());
      const open = () =>
        renderHook(() => useBookReadalong(REF, { ebook: EBOOK }, true), { wrapper });
      const first = await open();
      await waitFor(() => expect(first.result.current.map).not.toBeNull());
      const shown = first.result.current.map;
      await first.unmount();
      await new Promise((r) => setTimeout(r, 5));
      const again = await open();
      // At once, the same reader map, with no second read of the device.
      expect(again.result.current.map).toBe(shown);
      expect(mockReadKept).toHaveBeenCalledTimes(1);
      await again.unmount();
      // Another book's map read: the first is let go.
      const other = { ...REF, path: 'B/Other' };
      const third = await renderHook(() => useBookReadalong(other, { ebook: EBOOK }, true), {
        wrapper,
      });
      await waitFor(() => expect(third.result.current.map).not.toBeNull());
      await third.unmount();
      await new Promise((r) => setTimeout(r, 5));
      expect(
        client.getQueryCache().find({ queryKey: ['readalongLocal', 'c1', 1, 'A/Book', 'g1'] }),
      ).toBeUndefined();
      expect(
        client.getQueryCache().find({ queryKey: ['readalongLocal', 'c1', 1, 'B/Other', 'g1'] }),
      ).toBeDefined();
    });
  });

  describe("a map of another ebook than the download's (fe#193)", () => {
    // The server's map, made from the ebook `sha-2` (one object, as the query keeps it).
    const REMADE = map([SPAN], 'sha-2');
    beforeEach(() => {
      mockEbookSha = 'sha-1';
      mockServerMap.mockImplementation(({ enabled }: { enabled: boolean }) => ({
        data: enabled ? REMADE : undefined,
        isError: false,
      }));
    });

    it("follows the download's own copy instead", async () => {
      mockKept = 'g1';
      mockReadKept.mockResolvedValue(map([{ ...SPAN, start: 7, end: 8 }], 'sha-1'));
      const { result } = await renderHook(() => useBookReadalong(REF, ready('g2'), true), {
        wrapper,
      });
      await waitFor(() =>
        expect(result.current.map).toEqual({
          sections: [{ href: 'c1.xhtml', spans: [{ ...SPAN, start: 7, end: 8 }] }],
        }),
      );
      expect(result.current.failure).toBeNull();
    });

    it('says the ebook changed when the download kept no copy, never offering Try again', async () => {
      const { result } = await renderHook(() => useBookReadalong(REF, ready('g2'), true), {
        wrapper,
      });
      expect(result.current).toMatchObject({
        map: null,
        pending: false,
        failure: 'ebookChanged',
      });
    });

    it('without a sha kept, takes a server ebook of another size for another ebook', async () => {
      mockEbookSha = undefined;
      mockEbookSize = EBOOK.size + 1;
      const { result } = await renderHook(() => useBookReadalong(REF, ready('g2'), true), {
        wrapper,
      });
      expect(result.current).toMatchObject({ map: null, failure: 'ebookChanged' });
      // The same size: the server's map is taken.
      mockEbookSize = EBOOK.size;
      const same = await renderHook(() => useBookReadalong(REF, ready('g2'), true), { wrapper });
      expect(same.result.current.map).not.toBeNull();
    });

    it("takes the server's map of the same ebook", async () => {
      mockEbookSha = 'sha-2';
      const { result } = await renderHook(() => useBookReadalong(REF, ready('g2'), true), {
        wrapper,
      });
      expect(result.current.map).not.toBeNull();
      expect(mockReadKept).not.toHaveBeenCalled();
    });
  });

  describe('the EPUB actually opened after an unreadable download (F35)', () => {
    beforeEach(() => {
      mockKept = 'g1';
      mockEbookSha = 'sha-old';
      mockEbookSize = EBOOK.size;
      mockReadKept.mockResolvedValue(map([SPAN], 'sha-old'));
    });

    it('refuses both maps of the unreadable download when the same-size server EPUB replaced it', async () => {
      const old = map([SPAN], 'sha-old');
      mockServerMap.mockImplementation(({ enabled }: { enabled: boolean }) => ({
        data: enabled ? old : undefined,
        isError: false,
      }));
      const { result } = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
      await waitFor(() => expect(result.current.map).not.toBeNull());
      await act(async () =>
        result.current.onEbook({ source: 'server', size: EBOOK.size, sha256: 'sha-new' }),
      );
      await waitFor(() =>
        expect(result.current).toMatchObject({ map: null, failure: 'ebookChanged' }),
      );
    });

    it('allows a matching server map despite the unreadable download identity', async () => {
      mockKept = undefined;
      const matching = map([{ ...SPAN, start: 7, end: 8 }], 'sha-new');
      mockServerMap.mockImplementation(({ enabled }: { enabled: boolean }) => ({
        data: enabled ? matching : undefined,
        isError: false,
      }));
      const { result } = await renderHook(() => useBookReadalong(REF, ready(), true), { wrapper });
      expect(result.current).toMatchObject({ map: null, selectingEbook: true });
      await act(async () =>
        result.current.onEbook({ source: 'server', size: EBOOK.size, sha256: 'sha-new' }),
      );
      await waitFor(() =>
        expect(result.current).toMatchObject({
          map: { sections: matching.sections },
          failure: null,
          ebookSha256: 'sha-new',
          selectingEbook: false,
        }),
      );
    });

    it('keeps a matching local map with a cached server EPUB while offline', async () => {
      mockServes = undefined;
      const { result } = await renderHook(() => useBookReadalong(REF, { ebook: EBOOK }, true), {
        wrapper,
      });
      await waitFor(() => expect(result.current.map).not.toBeNull());
      await act(async () =>
        result.current.onEbook({ source: 'server', size: EBOOK.size, sha256: 'sha-old' }),
      );
      expect(result.current).toMatchObject({
        map: { sections: map([SPAN], 'sha-old').sections },
        failure: null,
      });
    });

    it('selects a same-target redownload again without reusing the old host identity', async () => {
      mockKept = undefined;
      const matching = map([SPAN], 'sha-new');
      mockServerMap.mockImplementation(({ enabled }: { enabled: boolean }) => ({
        data: enabled ? matching : undefined,
        isError: false,
      }));
      const { result, rerender } = await renderHook(
        () => useBookReadalong(REF, ready(), true, true, { reselectOnDownloadChange: true }),
        { wrapper },
      );
      await act(async () =>
        result.current.onEbook({ source: 'download', size: EBOOK.size, sha256: 'sha-old' }),
      );
      expect(result.current.failure).toBe('ebookChanged');
      const previous = result.current.ebookSelectionKey;
      const oldSelection = result.current.onEbook;
      mockEbookSha = 'sha-new';
      await rerender(undefined);
      expect(result.current.ebookSelectionKey).not.toBe(previous);
      expect(result.current.failure).toBeNull();
      // A late answer from the old selection cannot reject the new session's map.
      await act(async () =>
        oldSelection({ source: 'download', size: EBOOK.size, sha256: 'sha-old' }),
      );
      expect(result.current.failure).toBeNull();
      await act(async () =>
        result.current.onEbook({ source: 'download', size: EBOOK.size, sha256: 'sha-new' }),
      );
      expect(result.current.map).not.toBeNull();
    });
  });
});
