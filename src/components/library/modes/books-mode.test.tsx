import { fireEvent, render, screen } from '@testing-library/react-native';

import type { Book, Progress } from '@/api/types';
import { settleFlashList } from '@/testing/flash-list';

let mockParams: Record<string, string | undefined> = {};
const mockSetParams = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  router: { setParams: (p: unknown) => mockSetParams(p), push: jest.fn() },
}));
let mockWhole: {
  books: Book[];
  complete: boolean;
  isLoading: boolean;
  error: Error | null;
  retry: jest.Mock;
  refresh: jest.Mock;
};
jest.mock('../books/use-whole-library', () => ({ useWholeLibrary: () => mockWhole }));
let mockProgress: (Progress & { connectionId: string })[] = [];
jest.mock('@/api/hooks', () => ({ useAllProgressAll: () => ({ progress: mockProgress }) }));
jest.mock('@/downloads/store', () => ({
  useDownloads: (select: (s: object) => unknown) => select({ supported: true, entries: {} }),
  useDownloadEntry: () => undefined,
}));
jest.mock('../use-selected-library', () => ({
  useSelectedLibrary: () => ({ library: { name: 'Audiobooks' } }),
}));
// The rows and tiles have their own tests; here they only need to show the title.
jest.mock('../books/book-items', () => {
  const { Text: T } = jest.requireActual('react-native');
  return {
    BookTile: ({ book }: { book: Book }) => <T>{book.title}</T>,
    BookListRow: ({ book }: { book: Book }) => <T>{book.title}</T>,
    BookListHeader: () => null,
  };
});
jest.mock('../books/books-controls', () => ({ BooksControls: () => null }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
// The real FlashList, its ref's scrollToOffset spied on and its keys recorded: what a
// view change asks of the list.
const mockScrollToOffset = jest.fn();
let mockKeyOf: ((item: unknown, index: number) => string) | undefined;
let mockListProps: Record<string, unknown> = {};
jest.mock('@shopify/flash-list', () => {
  const actual = jest.requireActual('@shopify/flash-list');
  const { useImperativeHandle, useRef } = jest.requireActual('react');
  return {
    ...actual,
    FlashList: ({ ref, ...props }: { ref?: unknown; keyExtractor?: typeof mockKeyOf }) => {
      const inner = useRef(null);
      useImperativeHandle(ref, () => ({ scrollToOffset: mockScrollToOffset }));
      mockKeyOf = props.keyExtractor;
      mockListProps = props;
      return <actual.FlashList {...props} ref={inner} />;
    },
  };
});
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'phone',
}));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';
import { resetProfilesForTests } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';

import { BooksMode } from './books-mode';
/* eslint-enable import/first */

const H = 3600;
let id = 1;
const book = (title: string, duration = 3 * H): Book => ({
  id: id++,
  library_id: 1,
  rel_path: title,
  is_folder: true,
  title,
  author: 'Someone',
  series: '',
  series_index: 0,
  narrator: '',
  duration,
  format: 'm4b',
  size: 0,
});
const progress = (path: string, over: Partial<Progress> = {}) => ({
  connectionId: 'c',
  library_id: 1,
  path,
  position: 60,
  duration: 3 * H,
  finished: false,
  playback_speed: 1,
  version: 1,
  device_id: 'd',
  updated_at: '',
  ...over,
});

async function mount() {
  await render(<BooksMode connectionId="c" libraryId={1} />);
  const grid = screen.queryByTestId('cover-grid');
  if (grid) {
    await fireEvent(grid, 'layout', { nativeEvent: { layout: { width: 390, height: 800 } } });
  }
  await settleFlashList();
}

describe('BooksMode', () => {
  beforeEach(() => {
    mockParams = {};
    mockSetParams.mockReset();
    mockScrollToOffset.mockReset();
    mockProgress = [];
    mockWhole = {
      books: [book('Dune', 20 * H), book('Emma'), book('Beowulf', 2 * H)],
      complete: true,
      isLoading: false,
      error: null,
      retry: jest.fn(),
      refresh: jest.fn(),
    };
  });

  it('counts the books and each status from the listener’s progress', async () => {
    mockProgress = [
      progress('Dune'),
      progress('Emma', { finished: true }),
      // Another server's and another library's rows don't count here.
      { ...progress('Beowulf'), connectionId: 'other' },
      { ...progress('Beowulf'), library_id: 2 },
    ];
    await mount();
    expect(screen.getByText('3 books')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Not started, 1' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'In progress, 1' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Finished, 1' })).toBeTruthy();
    expect(screen.getByText('Dune')).toBeTruthy();
  });

  it('insets its scroller for the iOS tab bar itself (under the sections)', async () => {
    // The phone's segmented control is the page's first ScrollView, so react-native-screens
    // never insets the grid: its last row scrolled under the tab bar.
    await mount();
    expect(mockListProps.contentInsetAdjustmentBehavior).toBe('automatic');
    expect(mockListProps.keyboardShouldPersistTaps).toBe('handled');
  });

  it('filters from the URL and writes a chip back to it', async () => {
    mockParams = { len: 'long' };
    await mount();
    expect(screen.getByText('1 of 3 matches')).toBeTruthy();
    expect(screen.getByText('Dune')).toBeTruthy();
    expect(screen.queryByText('Emma')).toBeNull();
    await fireEvent.press(screen.getByRole('checkbox', { name: /^Not started/ }));
    expect(mockSetParams).toHaveBeenCalledWith({
      sort: undefined,
      status: 'new',
      dl: undefined,
      len: 'long',
    });
  });

  /** The chip row's host elements and texts, in order. */
  type Node = { props?: Record<string, unknown>; children?: (Node | string)[] } | string;
  function rowOrder(): string[] {
    const out: string[] = [];
    const walk = (n: Node) => {
      if (typeof n === 'string') return void out.push(n);
      const name = n.props?.testID ?? n.props?.accessibilityLabel;
      if (typeof name === 'string') out.push(name);
      n.children?.forEach(walk);
    };
    walk(screen.getByTestId('chip-row') as unknown as Node);
    return out;
  }
  const firstAt = (order: string[], re: RegExp) => order.findIndex((n) => re.test(n));

  // PLAYER-10: at the end of a long row, Clear and the chosen genre were off-screen at 390.
  it('leads the row with Clear and the chosen genre while a filter is on', async () => {
    mockWhole.books = [{ ...book('Dune', 20 * H), genres: ['Sci-Fi'] }, book('Emma')];
    mockParams = { genre: 'Sci-Fi' };
    await mount();
    const order = rowOrder();
    const clear = firstAt(order, /^books-clear-filters$/);
    const genre = firstAt(order, /^Genre: Sci-Fi/);
    const status = firstAt(order, /^Not started/);
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(clear).toBeLessThan(genre);
    expect(genre).toBeLessThan(status);
  });

  // The picker the listener scrolled to at the row's end moves to its start once chosen:
  // the row starts again from there (a new row), or the choice and Clear are off-screen.
  it('starts the row again from its start when a genre is chosen', async () => {
    mockWhole.books = [{ ...book('Dune', 20 * H), genres: ['Sci-Fi'] }, book('Emma')];
    await mount();
    const before = screen.getByTestId('chip-row');
    mockParams = { status: 'finished' };
    await screen.rerender(<BooksMode connectionId="c" libraryId={1} />);
    expect(screen.getByTestId('chip-row')).toBe(before);
    mockParams = { status: 'finished', genre: 'Sci-Fi' };
    await screen.rerender(<BooksMode connectionId="c" libraryId={1} />);
    expect(screen.getByTestId('chip-row')).not.toBe(before);
  });

  it('keeps an unchosen genre picker at the end, and no Clear without a filter', async () => {
    mockWhole.books = [{ ...book('Dune', 20 * H), genres: ['Sci-Fi'] }, book('Emma')];
    await mount();
    expect(screen.queryByTestId('books-clear-filters')).toBeNull();
    const order = rowOrder();
    expect(firstAt(order, /^Genre$/)).toBeGreaterThan(firstAt(order, /^Long/));
  });

  it('files the title order under letter heads', async () => {
    mockParams = { sort: 'title' };
    await mount();
    expect(screen.getByRole('header', { name: 'B' })).toBeTruthy();
    expect(screen.getByRole('header', { name: 'D' })).toBeTruthy();
    // The A-Z rail: letters with books jump, the others are disabled.
    expect(screen.getByRole('button', { name: 'Jump to D' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Jump to C' })).toBeDisabled();
  });

  it('says when nothing matches and clears every filter', async () => {
    mockParams = { status: 'finished', sort: 'title' };
    await mount();
    expect(screen.getByText('No books match these filters')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Clear filters' }));
    expect(mockSetParams).toHaveBeenCalledWith({
      sort: 'title',
      status: undefined,
      dl: undefined,
      len: undefined,
    });
  });

  it('says when the library is empty', async () => {
    mockWhole.books = [];
    await mount();
    expect(screen.getByText('No books in Audiobooks yet')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    expect(mockWhole.refresh).toHaveBeenCalled();
  });

  it('keeps counts honest while pages are still arriving', async () => {
    mockWhole.complete = false;
    await mount();
    expect(screen.getByText('3+ books')).toBeTruthy();
    expect(screen.getByText('Loading more...')).toBeTruthy();
  });

  it('opens a new sort or filter at the top, and keeps the place as pages arrive', async () => {
    mockWhole.complete = false;
    await mount();
    const dune = (keyOf = mockKeyOf!) => keyOf({ kind: 'item', item: mockWhole.books[0] }, 0);
    const recentKey = dune();
    const again = () => screen.rerender(<BooksMode connectionId="c" libraryId={1} />);

    // A page arrives: same keys (FlashList anchors the listener's place on them), no scroll.
    mockWhole = { ...mockWhole, books: [...mockWhole.books, book('Aesop'), book('Zola')] };
    await again();
    await settleFlashList();
    expect(screen.getByText('5+ books')).toBeTruthy();
    expect(dune()).toBe(recentKey);
    expect(mockScrollToOffset).not.toHaveBeenCalled();

    // A new sort: new keys (nothing to anchor across the change) and back to the top.
    mockParams = { sort: 'title' };
    await again();
    await settleFlashList();
    expect(screen.getByRole('header', { name: 'A' })).toBeTruthy();
    expect(dune()).not.toBe(recentKey);
    expect(mockScrollToOffset).toHaveBeenCalledTimes(1);
    expect(mockScrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });

    // A filter too.
    mockParams = { sort: 'title', len: 'long' };
    await again();
    await settleFlashList();
    expect(mockScrollToOffset).toHaveBeenCalledTimes(2);

    // And another page in the filtered view stays put.
    mockWhole = { ...mockWhole, books: [...mockWhole.books, book('Ulysses', 30 * H)] };
    await again();
    await settleFlashList();
    expect(screen.getByText('Ulysses')).toBeTruthy();
    expect(mockScrollToOffset).toHaveBeenCalledTimes(2);
  });

  it('offers Retry on a failed load, keeping what loaded', async () => {
    mockWhole.error = new Error('offline');
    mockWhole.complete = false;
    await mount();
    expect(screen.getByText("Couldn't load every book")).toBeTruthy();
    expect(screen.getByText('Dune')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(mockWhole.retry).toHaveBeenCalled();

    mockWhole.books = [];
    await mount();
    expect(screen.getByText("Couldn't load the books")).toBeTruthy();
    // frontend#131: a failed list counts nothing ("Not started 0" is not true).
    expect(screen.getByRole('checkbox', { name: 'Not started' })).toBeTruthy();
    expect(screen.queryByText('0 books')).toBeNull();
  });

  // frontend#124: a refused session is one sign-in state, never a Retry.
  it('asks to sign in again, with no Retry, when its server refused the session', async () => {
    resetProfilesForTests();
    const before = useSession.getState().connections;
    useSession.setState({
      connections: [
        { id: 'c', name: 'Hearthside', serverUrl: 'https://h', token: 't', needsReconnect: 'auth' },
      ] as Connection[],
    });
    try {
      mockWhole.books = [];
      mockWhole.error = new ApiError(401, 'unauthorized');
      await mount();
      expect(screen.getByText('Sign in again to Hearthside')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
      expect(screen.queryByText("Couldn't load the books")).toBeNull();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    } finally {
      screen.unmount();
      useSession.setState({ connections: before });
    }
  });
});
