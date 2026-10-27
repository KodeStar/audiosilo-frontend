import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Book, BookPage } from '@/api/types';

const mockListBooks = jest.fn<Promise<BookPage>, [number, { cursor?: string }]>();
jest.mock('@/api/provider', () => ({
  useCid: (id?: string) => id ?? 'c1',
  useOptionalApi: () => ({ listBooks: mockListBooks }),
}));

// `afterPaint` held by the test (web: the frame and an idle moment after the first page),
// so it can say when the first page has painted. Runs at once unless a test holds it.
const mockPaint = { hold: false };
const mockPainted: (() => void)[] = [];
jest.mock('@/lib/after-paint', () => ({
  afterPaint: (fn: () => void) => {
    if (!mockPaint.hold) {
      fn();
      return () => {};
    }
    mockPainted.push(fn);
    return () => {
      const i = mockPainted.indexOf(fn);
      if (i >= 0) mockPainted.splice(i, 1);
    };
  },
}));

/* eslint-disable import/first */
import { useWholeLibrary } from './use-whole-library';
/* eslint-enable import/first */

const books = (...titles: string[]) => titles.map((title) => ({ title }) as Book);

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return (await renderHook(() => useWholeLibrary('c1', 1), { wrapper })).result;
}

describe('useWholeLibrary', () => {
  beforeEach(() => {
    mockListBooks.mockReset();
    mockPaint.hold = false;
    mockPainted.length = 0;
  });

  it('shows the first page and asks for the rest only once it has painted', async () => {
    mockPaint.hold = true;
    mockListBooks.mockImplementation(async (_lib, opts) =>
      !opts.cursor ? { books: books('A'), next_cursor: 'p2' } : { books: books('B') },
    );
    const result = await mount();
    await waitFor(() => expect(result.current.books.map((b) => b.title)).toEqual(['A']));
    expect(result.current.complete).toBe(false);
    expect(mockListBooks).toHaveBeenCalledTimes(1);
    expect(mockPainted).toHaveLength(1);

    await act(async () => mockPainted.shift()?.());
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.books.map((b) => b.title)).toEqual(['A', 'B']);
    expect(mockListBooks.mock.calls[1][1]).toMatchObject({ cursor: 'p2' });
  });

  it('fetches page after page of 200 until the cursor runs out', async () => {
    mockListBooks.mockImplementation(async (_lib, opts) =>
      !opts.cursor
        ? { books: books('A', 'B'), next_cursor: 'p2' }
        : opts.cursor === 'p2'
          ? { books: books('C'), next_cursor: 'p3' }
          : { books: books('D') },
    );
    const result = await mount();
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.books.map((b) => b.title)).toEqual(['A', 'B', 'C', 'D']);
    expect(mockListBooks).toHaveBeenCalledTimes(3);
    expect(mockListBooks.mock.calls[0][1]).toEqual({
      sort: 'recent',
      limit: 200,
      cursor: undefined,
    });
    expect(mockListBooks.mock.calls[2][1]).toMatchObject({ cursor: 'p3' });
  });

  it('keeps the pages that loaded when one fails, and carries on from there on retry', async () => {
    let failing = true;
    mockListBooks.mockImplementation(async (_lib, opts) => {
      if (!opts.cursor) return { books: books('A'), next_cursor: 'p2' };
      if (failing) throw new Error('offline');
      return { books: books('B') };
    });
    const result = await mount();
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.books.map((b) => b.title)).toEqual(['A']);
    expect(result.current.complete).toBe(false);

    failing = false;
    await act(async () => result.current.retry());
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.books.map((b) => b.title)).toEqual(['A', 'B']);
    // The first page was not asked for again.
    expect(mockListBooks.mock.calls.filter(([, o]) => !o.cursor)).toHaveLength(1);
  });
});
