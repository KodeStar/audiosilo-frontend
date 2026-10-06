import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Book } from '@/api/types';
import BookDetailScreen from '@/app/(app)/(home,library,search,offline,me)/book/[libraryId]';
import type { LayoutClass } from '@/lib/layout';

// The book page's primary button. On tablet/desktop the page plays INLINE (the docked
// player bar is the transport), so "Listen" calls playBook - which, for the book that is
// already loaded, restarts it from the saved position. While THIS book is loaded the
// button must open the player instead, in BOTH layouts: the two panes and the single
// column a tablet/desktop page falls back to when it is too narrow (the Up next drawer
// can leave a desktop page phone-narrow).

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h) },
  useLocalSearchParams: () => ({ libraryId: '1', path: ['Author', 'Book'] }),
}));

const mockBook = {
  id: 1,
  library_id: 1,
  rel_path: 'Author/Book',
  is_folder: true,
  title: 'The Book',
  author: 'An Author',
  series: '',
  series_index: 0,
  narrator: '',
  duration: 3600,
  format: 'm4b',
  size: 1,
} as Book;
const mockChapters = { chapters: [], files: [{ rel_path: 'Author/Book/a.m4b', duration: 3600 }] };
jest.mock('@/api/hooks', () => ({
  useBook: () => ({ data: mockBook, isLoading: false, refetch: jest.fn() }),
  useChapters: () => ({ data: mockChapters, isLoading: false }),
  useLibraries: () => ({ data: [{ id: 1, name: 'Books' }] }),
  useServerInfo: () => ({ data: { capabilities: {} } }),
  useBookMeta: () => ({ data: undefined }),
  useBookProgress: () => ({ data: undefined }),
}));
jest.mock('@/api/provider', () => ({
  useApi: () => ({ coverUrl: () => 'https://s/c', authHeaders: () => ({}) }),
  useScopedCid: () => 'home',
}));
jest.mock('@/components/layout/content-scope', () => ({
  ContentScope: ({ children }: { children: ReactNode }) => children,
}));

let mockLayout: LayoutClass = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));

let mockNowPlaying: { connectionId: string; libraryId: number; path: string } | null = null;
const mockPlayBook = jest.fn(() => Promise.resolve());
jest.mock('@/playback/store', () => ({
  usePlayer: Object.assign((sel: (s: unknown) => unknown) => sel({ nowPlaying: mockNowPlaying }), {
    getState: () => ({ playBook: mockPlayBook }),
  }),
  selectCurrentChapter: () => null,
}));

// Sections with their own data and tests, irrelevant to the primary button.
jest.mock('@/components/library/book-stats', () => ({ BookStats: () => null }));
jest.mock('@/components/library/book-versions', () => ({ BookVersions: () => null }));
jest.mock('@/components/library/bookmarks-section', () => ({ BookmarksSection: () => null }));
jest.mock('@/components/library/history-section', () => ({ HistorySection: () => null }));
jest.mock('@/components/library/notes-section', () => ({ NotesSection: () => null }));
jest.mock('@/components/library/download-control', () => ({
  DownloadControl: () => null,
  DownloadProgress: () => null,
}));
jest.mock('@/components/player/cover-backdrop', () => ({ CoverBackdrop: () => null }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/components/player/use-listening-position', () => ({
  useListeningPosition: () => undefined,
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/downloads/store', () => ({ useDownloadEntry: () => undefined }));
jest.mock('@/stores/series-orderings', () => ({
  useSeriesOrderings: (sel: (s: unknown) => unknown) => sel({ picks: {}, pick: jest.fn() }),
}));

const THIS_BOOK = { connectionId: 'home', libraryId: 1, path: 'Author/Book' };

/** Renders the page and, for a measured width, lays it out at that width (the page
 * starts at 0, "not measured", which trusts the layout class). */
async function mountAt(layout: LayoutClass, width?: number) {
  mockLayout = layout;
  await render(<BookDetailScreen />);
  if (width !== undefined) {
    const page = screen.queryByTestId('book-two-pane') ?? screen.getByTestId('book-single-column');
    await fireEvent(page, 'layout', { nativeEvent: { layout: { width, height: 800 } } });
  }
}

beforeEach(() => {
  mockNowPlaying = null;
  mockPush.mockClear();
  mockPlayBook.mockClear();
});

describe('book page primary action', () => {
  it('opens the player, never restarts, on a desktop page too narrow for two panes', async () => {
    mockNowPlaying = THIS_BOOK;
    // 1024 less a 360 Up next drawer.
    await mountAt('desktop', 664);
    expect(screen.getByTestId('book-single-column')).toBeTruthy();
    expect(screen.queryByText('Listen')).toBeNull();
    await fireEvent.press(screen.getByText('Open the player'));
    expect(mockPush).toHaveBeenCalledWith('/player');
    expect(mockPlayBook).not.toHaveBeenCalled();
  });

  it('does the same in the two panes', async () => {
    mockNowPlaying = THIS_BOOK;
    await mountAt('desktop');
    expect(screen.getByTestId('book-two-pane')).toBeTruthy();
    expect(screen.queryByText('Listen')).toBeNull();
    expect(screen.getByText('Open the player')).toBeTruthy();
  });

  it('plays inline when another book is loaded', async () => {
    mockNowPlaying = { ...THIS_BOOK, path: 'Author/Other' };
    await mountAt('tablet', 600);
    expect(screen.getByTestId('book-single-column')).toBeTruthy();
    await fireEvent.press(screen.getByText('Listen'));
    expect(mockPlayBook).toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('keeps Listen on a phone, whose Listen opens the player modal on the book', async () => {
    mockNowPlaying = THIS_BOOK;
    await mountAt('phone');
    expect(screen.queryByText('Open the player')).toBeNull();
    await fireEvent.press(screen.getByText('Listen'));
    expect(mockPlayBook).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/player' }));
  });
});
