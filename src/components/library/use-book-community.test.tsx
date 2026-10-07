import { renderHook } from '@testing-library/react-native';

let mockMetadata: boolean | undefined;
let mockBook: { asin?: string; isbn?: string } | undefined;
const mockBookOpts = jest.fn();
const mockChapterOpts = jest.fn();
const mockMetaEnabled = jest.fn();
let mockMeta: unknown;
jest.mock('@/api/hooks', () => ({
  useCapability: () => mockMetadata,
  useBook: (_l: number, _p: string, _c: string, opts: unknown) => {
    mockBookOpts(opts);
    return { data: mockBook, isLoading: false };
  },
  useChapters: (_l: number, _p: string, _c: string, opts: unknown) => {
    mockChapterOpts(opts);
    return { data: { chapters: [], files: [] }, isLoading: false };
  },
  useBookMeta: (_l: number, _p: string, enabled: boolean) => {
    mockMetaEnabled(enabled);
    return { data: enabled ? mockMeta : undefined, isLoading: false };
  },
}));
// book-meta (for matchedMeta) pulls in CoverFrame, whose shadow hook reads the theme.
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));

/* eslint-disable import/first */
import { useBookCommunity } from './use-book-community';
/* eslint-enable import/first */

const target = { connectionId: 'c1', libraryId: 1, path: 'A/Book' };
const work = { id: 'w', title: 'W', characters: [], recaps: [] };

beforeEach(() => {
  mockBookOpts.mockClear();
  mockChapterOpts.mockClear();
  mockMetaEnabled.mockClear();
  mockMeta = { matched: true, work, series: [] };
});

describe('useBookCommunity', () => {
  it('asks for nothing on a server without metadata', async () => {
    mockMetadata = false;
    mockBook = { asin: 'B0' };
    const { result } = await renderHook(() => useBookCommunity(target));
    expect(mockBookOpts).toHaveBeenLastCalledWith({ enabled: false });
    expect(mockChapterOpts).toHaveBeenLastCalledWith({ enabled: false });
    expect(mockMetaEnabled).toHaveBeenLastCalledWith(false);
    expect(result.current.work).toBeUndefined();
    expect(result.current.loading).toBe(false);
  });

  it('reads the book but not its chapters or /meta when it has no ASIN or ISBN', async () => {
    mockMetadata = true;
    mockBook = {};
    const { result } = await renderHook(() => useBookCommunity(target));
    expect(mockBookOpts).toHaveBeenLastCalledWith({ enabled: true });
    expect(mockChapterOpts).toHaveBeenLastCalledWith({ enabled: false });
    expect(mockMetaEnabled).toHaveBeenLastCalledWith(false);
    expect(result.current.enabled).toBe(false);
  });

  it('follows the chain to the matched work', async () => {
    mockMetadata = true;
    mockBook = { isbn: '978' };
    const { result } = await renderHook(() => useBookCommunity(target));
    expect(mockChapterOpts).toHaveBeenLastCalledWith({ enabled: true });
    expect(result.current.work).toBe(work);
    expect(result.current.chapterStarts).toEqual([]);
  });

  it('is loading while the capability is unknown', async () => {
    mockMetadata = undefined;
    const { result } = await renderHook(() => useBookCommunity(target));
    expect(result.current.loading).toBe(true);
  });
});
