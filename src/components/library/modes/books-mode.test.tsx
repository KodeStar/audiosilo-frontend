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
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'phone',
}));

/* eslint-disable import/first */
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
  });
});
