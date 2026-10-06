import { act, render } from '@testing-library/react-native';

let mockLayout: 'phone' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
const mockUseBook = jest.fn();
jest.mock('@/api/hooks', () => ({
  useBook: (lib: number, path: string, cid: string) => mockUseBook(lib, path, cid),
  useAllProgressAll: () => ({
    progress: [{ connectionId: 'c', library_id: 1, path: 'Dune', position: 9 }],
  }),
}));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

// The menu itself is BookActionsMenu's (book-actions tests); here only what the tile
// asks of it: the book, the saved progress, when the sheet is open, opening the anchor.
const mockOpen = jest.fn();
let mockMenu: { sheetOpen: boolean; progress?: unknown; book: unknown } | null = null;
let mockCloseSheet: () => void = () => {};
jest.mock('./books/book-actions', () => {
  const { forwardRef: fr, useImperativeHandle: imp } = jest.requireActual('react');
  const Anchor = fr((_p: object, ref: unknown) => {
    imp(ref, () => ({ open: mockOpen }));
    return null;
  });
  return {
    BookActionsMenu: (p: {
      sheetOpen: boolean;
      progress?: unknown;
      book: unknown;
      triggerRef: unknown;
      onSheetOpenChange: (o: boolean) => void;
    }) => {
      mockMenu = p;
      mockCloseSheet = () => p.onSheetOpenChange(false);
      return <Anchor ref={p.triggerRef} />;
    },
  };
});

/* eslint-disable import/first */
import type { Book } from '@/api/types';

import { TileActions } from './tile-actions';
/* eslint-enable import/first */

const book = { rel_path: 'Dune', title: 'Dune' } as Book;
const props = (request: number, given?: Book) => ({
  connectionId: 'c',
  libraryId: 1,
  path: 'Dune',
  book: given,
  request,
  tileRef: { current: null },
});

beforeEach(() => {
  mockLayout = 'desktop';
  mockMenu = null;
  mockOpen.mockReset();
  mockToast.mockReset();
  mockUseBook.mockReset().mockReturnValue({ data: undefined, isError: false });
});

describe('TileActions', () => {
  it("uses the screen's row without a fetch and opens the anchored menu once per request", async () => {
    const r = await render(<TileActions {...props(1, book)} />);
    expect(mockUseBook).toHaveBeenCalledWith(1, '', 'c');
    expect(mockMenu?.book).toBe(book);
    expect(mockMenu?.progress).toMatchObject({ position: 9 });
    expect(mockOpen).toHaveBeenCalledTimes(1);
    await r.rerender(<TileActions {...props(1, book)} />);
    expect(mockOpen).toHaveBeenCalledTimes(1);
    await r.rerender(<TileActions {...props(2, book)} />);
    expect(mockOpen).toHaveBeenCalledTimes(2);
  });

  it('fetches the row when the screen has none, and waits for it', async () => {
    const r = await render(<TileActions {...props(1)} />);
    expect(mockUseBook).toHaveBeenCalledWith(1, 'Dune', 'c');
    expect(mockMenu).toBeNull();
    mockUseBook.mockReturnValue({ data: book, isError: false });
    await r.rerender(<TileActions {...props(1)} />);
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  it('says so when the row cannot load', async () => {
    mockUseBook.mockReturnValue({ data: undefined, isError: true });
    await render(<TileActions {...props(1)} />);
    expect(mockToast).toHaveBeenCalledWith({ title: "Couldn't load this book. Try again." });
  });

  it('opens the sheet on a phone until it is closed, and again on the next request', async () => {
    mockLayout = 'phone';
    const r = await render(<TileActions {...props(1, book)} />);
    expect(mockMenu?.sheetOpen).toBe(true);
    expect(mockOpen).not.toHaveBeenCalled();
    await act(async () => mockCloseSheet());
    expect(mockMenu?.sheetOpen).toBe(false);
    await r.rerender(<TileActions {...props(2, book)} />);
    expect(mockMenu?.sheetOpen).toBe(true);
  });
});
