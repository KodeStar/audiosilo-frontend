import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';
import { Platform } from 'react-native';

import type { Book, BookMeta, Bookmark, ChaptersResponse, Progress } from '@/api/types';
import type { LayoutClass } from '@/lib/layout';
import { mountWithPortal } from '@/testing/render-overlay';

// The book page over stand-ins for its data (the hooks), the player (the shared store
// double) and the sections other suites own. What it pins: the primary action per state
// (and that it never restarts the loaded book), the layout by the MEASURED width, the
// hero's place, the Chapters tab's whole-book timeline for a book that is NOT playing,
// the Details tab, an unmatched book reading complete, and the load and error states.

const mockPush = jest.fn();
let mockParams: Record<string, unknown> = { libraryId: '1', path: ['Author', 'Book'] };
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h) },
  useLocalSearchParams: () => mockParams,
}));

let mockBook: Book | undefined;
let mockBookLoading = false;
let mockChapters: ChaptersResponse | undefined;
let mockProgress: Progress | null = null;
let mockMeta: BookMeta | undefined;
let mockCaps: Record<string, boolean> = {};
const mockRefetch = jest.fn();
jest.mock('@/api/hooks', () => ({
  ...jest.requireActual('@/api/hooks'),
  useBook: () => ({ data: mockBook, isLoading: mockBookLoading, refetch: mockRefetch }),
  useChapters: () => ({ data: mockChapters, isLoading: false }),
  useLibraries: () => ({ data: [{ id: 1, name: 'Fiction' }] }),
  useCapability: (flag: string) => mockCaps[flag] ?? false,
  useBookMeta: () => ({ data: mockMeta }),
  useBookProgress: () => ({ data: mockProgress, isPending: false }),
  useFavourites: () => ({ data: [] }),
  useToggleFavourite: () => ({ mutate: jest.fn() }),
  useQueue: () => ({ data: undefined }),
  useRating: () => ({ data: null }),
  useMyRatings: () => ({ data: [], isError: false }),
  useSetRating: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => null,
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

jest.mock('@/playback/store', () =>
  // `require` because a jest.mock factory is hoisted above every import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

const mockStartBook = jest.fn((..._args: unknown[]) => Promise.resolve());
jest.mock('@/components/player/use-play-book', () => ({
  usePlayBook: () => mockStartBook,
}));

let mockBookmarks: Bookmark[] = [];
const mockAnnotationsFor = jest.fn();
jest.mock('@/components/player/use-playing-pins', () => {
  const actual = jest.requireActual('@/components/player/use-playing-pins');
  return {
    ...actual,
    useBookAnnotations: (target: unknown) => {
      mockAnnotationsFor(target);
      return { bookmarks: mockBookmarks, notes: [], pins: actual.pinsOf(mockBookmarks, []) };
    },
  };
});

// Sections with their own data and tests.
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
jest.mock('@/components/library/book-versions', () => ({ BookVersions: () => null }));
jest.mock('@/components/library/bookmarks-section', () => ({ BookmarksSection: () => null }));
jest.mock('@/components/library/history-section', () => ({ HistorySection: () => null }));
jest.mock('@/components/library/notes-section', () => ({ NotesSection: () => null }));
jest.mock('@/components/library/download-control', () => ({
  DownloadControl: () => null,
  DownloadProgress: () => null,
}));
jest.mock('@/components/library/books/book-actions', () => ({
  BookActionsMenu: ({ trigger }: { trigger: ReactElement }) => trigger,
}));
jest.mock('@/components/library/use-queue-actions', () => ({
  useQueueActions: () => ({ supported: false }),
  findQueued: () => undefined,
}));
// The timeline's gesture needs the native runtime; its own suite covers it.
jest.mock('react-native-gesture-handler', () => ({
  ...jest.requireActual('react-native-gesture-handler'),
  GestureDetector: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/downloads/store', () => ({ useDownloadEntry: () => undefined }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));

/* eslint-disable import/first */
import { playerStoreMock } from '@/testing/player-store-mock';
import { useSession } from '@/stores/session';

import { BookScreen } from './book-page';
/* eslint-enable import/first */

const player = playerStoreMock();
const mockPlayBook = jest.fn((..._args: unknown[]) => Promise.resolve());

const BOOK: Book = {
  id: 1,
  library_id: 1,
  rel_path: 'Author/Book',
  is_folder: true,
  title: 'The Way of Kings',
  author: 'Brandon Sanderson',
  series: 'The Stormlight Archive',
  series_index: 1,
  narrator: 'Michael Kramer',
  duration: 3000,
  format: 'm4b',
  size: 30_000_000,
  codec: 'aac',
  published: '2010',
};

const CHAPTERS: ChaptersResponse = {
  library_id: 1,
  path: 'Author/Book',
  duration: 3000,
  is_folder: true,
  codec: 'aac',
  files: [
    { rel_path: 'Author/Book/book.m4b', seq: 0, duration: 3000, format: 'm4b', size: 30_000_000 },
  ],
  chapters: [0, 1000, 2000].map((start, i) => ({
    index: i,
    title: ['Prelude', 'Stormblessed', 'Honor Is Dead'][i],
    file_index: 0,
    file_path: 'Author/Book/book.m4b',
    start,
    end: start + 1000,
    book_offset: start,
  })),
};

const progressAt = (position: number, finished = false): Progress => ({
  library_id: 1,
  path: 'Author/Book',
  position,
  duration: 3000,
  finished,
  playback_speed: 1.25,
  version: 0,
  device_id: 'd',
  updated_at: '2026-10-01T00:00:00Z',
  ...(finished ? { finished_at: '2026-10-03T09:00:00Z' } : {}),
});

const THIS_BOOK = {
  connectionId: 'home',
  libraryId: 1,
  path: 'Author/Book',
  queue: { chapters: CHAPTERS.chapters, total: 3000 },
};

/** Renders the page and, for a measured width, lays it out at that width (the page
 * starts at 0, "not measured", which trusts the layout class). */
async function mountAt(layout: LayoutClass, width?: number) {
  mockLayout = layout;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await mountWithPortal(
    <QueryClientProvider client={client}>
      <BookScreen />
    </QueryClientProvider>,
  );
  if (width !== undefined) {
    await fireEvent(screen.getByTestId('book-page'), 'layout', {
      nativeEvent: { layout: { width, height: 900 } },
    });
  }
}

beforeEach(() => {
  mockParams = { libraryId: '1', path: ['Author', 'Book'] };
  mockBook = BOOK;
  mockBookLoading = false;
  mockChapters = CHAPTERS;
  mockProgress = null;
  mockMeta = undefined;
  mockCaps = {};
  mockBookmarks = [];
  mockPush.mockClear();
  mockStartBook.mockClear();
  mockPlayBook.mockClear();
  player.reset();
  player.clearSpies();
  player.patch({ playBook: mockPlayBook } as never);
  useSession.setState({
    connections: [{ id: 'home', name: 'Hearthside', serverUrl: 'https://h', token: 't' }],
  } as never);
});

describe('book page primary action', () => {
  it('says Resume chapter N for a book in progress, and plays it through the one play path', async () => {
    mockProgress = progressAt(1500);
    await mountAt('desktop');
    // 1500 s is in the second of three chapters.
    await fireEvent.press(screen.getByRole('button', { name: 'Resume chapter 2' }));
    expect(mockStartBook).toHaveBeenCalledWith(
      { connectionId: 'home', libraryId: 1, path: 'Author/Book' },
      { toggle: true },
    );
    expect(screen.queryByText('Listen')).toBeNull();
  });

  it('says Pause while this book plays, and never restarts it', async () => {
    mockProgress = progressAt(1500);
    player.patch({
      nowPlaying: THIS_BOOK as never,
      bookPosition: 1600,
      snapshot: { ...player.usePlayer.getState().snapshot, state: 'playing' },
    });
    // 1024 less a 360 Up next drawer.
    await mountAt('desktop', 664);
    await fireEvent.press(screen.getByRole('button', { name: 'Pause' }));
    // The play path toggles the loaded book in place.
    expect(mockStartBook).toHaveBeenCalledWith(expect.anything(), { toggle: true });
    expect(mockPlayBook).not.toHaveBeenCalled();
  });

  it('offers a new book from the start and a finished one again, with its date and stars', async () => {
    await mountAt('tablet');
    expect(screen.getByRole('button', { name: 'Start listening' })).toBeTruthy();

    mockProgress = progressAt(3000, true);
    mockCaps = { ratings: true };
    await mountAt('tablet');
    expect(screen.getByRole('button', { name: 'Listen again' })).toBeTruthy();
    expect(screen.getByText(/^Finished (3 Oct|Oct 3)$/)).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(5);
  });
});

describe('book page tabs', () => {
  // The Bookmarks and Notes tabs read and write their entries under the route's path; the
  // tab counts and the pins must read the same ones, or an add there never moves them.
  it("counts and pins the annotations under the route's path, not the book's rel_path", async () => {
    mockBook = { ...BOOK, rel_path: 'Author/Book/' };
    await mountAt('desktop');
    expect(mockAnnotationsFor).toHaveBeenLastCalledWith({
      connectionId: 'home',
      libraryId: 1,
      path: 'Author/Book',
    });
  });
});

describe('book page hero', () => {
  it("shows the listener's place: percent, chapter and time left at the book's speed", async () => {
    mockProgress = progressAt(1500);
    await mountAt('desktop');
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText(/ · Chapter 2 of 3$/)).toBeTruthy();
    // 1500 s left at 1.25x is 20 minutes.
    expect(screen.getByText('20m left at 1.25×')).toBeTruthy();
  });

  it('opens the series, the author and the narrator from the eyebrow and byline', async () => {
    mockCaps = { browse_people: true };
    await mountAt('desktop');
    await fireEvent.press(
      screen.getByRole('link', { name: 'Open the series The Stormlight Archive' }),
    );
    await fireEvent.press(screen.getByRole('link', { name: 'Books by Brandon Sanderson' }));
    await fireEvent.press(screen.getByRole('link', { name: 'Books read by Michael Kramer' }));
    const paths = mockPush.mock.calls.map(([h]) => (h as { pathname: string }).pathname);
    expect(paths).toEqual(['/series', '/author', '/narrator']);
  });

  it('keeps a narrator without a page as plain text', async () => {
    mockCaps = { browse_people: false };
    await mountAt('desktop');
    expect(screen.queryByRole('link', { name: 'Books read by Michael Kramer' })).toBeNull();
    expect(screen.getByText('Michael Kramer')).toBeTruthy();
  });
});

describe('book page layout', () => {
  it('puts the aside beside the tabs on a roomy page and between hero and tabs when narrow', async () => {
    await mountAt('desktop', 1376);
    expect(screen.getByTestId('book-body-2')).toBeTruthy();
    await mountAt('desktop', 664);
    expect(screen.getByTestId('book-body-1')).toBeTruthy();
    await mountAt('phone', 400);
    expect(screen.getByTestId('book-body-1')).toBeTruthy();
  });

  it('opens on the tab a link asks for, and adds Details on every book', async () => {
    mockParams = { ...mockParams, tab: 'details' };
    await mountAt('desktop');
    expect(screen.getByTestId('book-tab-details')).toBeTruthy();
    expect(screen.getByText('Direct play')).toBeTruthy();
  });
});

describe('book page chapters tab', () => {
  it("draws a not-playing book's whole-book timeline with its bookmark pins", async () => {
    mockProgress = progressAt(1500);
    mockBookmarks = [{ id: 1, position: 500 } as Bookmark, { id: 2, position: 2500 } as Bookmark];
    await mountAt('desktop');
    expect(screen.getByTestId('book-whole-timeline')).toBeTruthy();
    expect(screen.getAllByTestId('timeline-bookmark')).toHaveLength(2);
    // Chapter 1 is behind the listener, 2 is where they are.
    expect(screen.getByRole('button', { name: /^Prelude, listened, has a bookmark/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Stormblessed, you're here/ })).toBeTruthy();
    // The tab counts what it holds.
    expect(screen.getByTestId('book-tab-chapters')).toHaveTextContent(/Chapters\s*3/);
    expect(screen.getByTestId('book-tab-bookmarks')).toHaveTextContent(/Bookmarks\s*2/);
  });

  // Where the jump goes (the player on a phone, in place elsewhere, the loaded book
  // seeking) is the one play path's (`playRoute`, its own table).
  it('jumps to a chapter through the one play path, for the playing book too', async () => {
    const target = { connectionId: 'home', libraryId: 1, path: 'Author/Book' };
    await mountAt('desktop');
    await fireEvent.press(screen.getByRole('button', { name: /^Honor Is Dead/ }));
    expect(mockStartBook).toHaveBeenLastCalledWith(target, { at: { position: 2000 } });

    player.patch({ nowPlaying: THIS_BOOK as never });
    await mountAt('phone');
    await fireEvent.press(screen.getByRole('button', { name: /^Stormblessed/ }));
    expect(mockStartBook).toHaveBeenLastCalledWith(target, { at: { position: 1000 } });
    expect(mockPlayBook).not.toHaveBeenCalled();
  });

  it('lists a long chapterless file in parts, and says why', async () => {
    mockBook = { ...BOOK, duration: 2 * 3600 };
    mockChapters = { ...CHAPTERS, duration: 2 * 3600, chapters: [] };
    await mountAt('desktop');
    expect(screen.getByTestId('book-tab-chapters')).toHaveTextContent(/Parts\s*4/);
    expect(screen.getByText('This book has no chapter marks')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Part 3/ })).toBeTruthy();
  });
});

describe('book page details tab', () => {
  it('lists the files with an about-kbps bitrate and the path the progress keys on', async () => {
    mockParams = { ...mockParams, tab: 'details' };
    await mountAt('desktop', 1376);
    expect(screen.getByText('book.m4b')).toBeTruthy();
    expect(screen.getByText('about 80 kbps')).toBeTruthy();
    expect(screen.getByText('Path on Hearthside')).toBeTruthy();
    expect(screen.getByText('Author/Book')).toBeTruthy();
  });

  it('says converted for this browser on web when the server transcodes it', async () => {
    const os = Platform.OS;
    Platform.OS = 'web';
    try {
      mockParams = { ...mockParams, tab: 'details' };
      mockBook = { ...BOOK, codec: 'ac3', direct_playable: false };
      mockChapters = { ...CHAPTERS, codec: 'ac3', direct_playable: false };
      mockCaps = { transcode: true };
      await mountAt('desktop');
      expect(screen.getByText('Converted for this browser')).toBeTruthy();
      expect(screen.getByText(/can't play AC-3, so Hearthside converts it/)).toBeTruthy();
    } finally {
      Platform.OS = os;
    }
  });
});

describe('book page states', () => {
  it('reads complete for an unmatched book without a description', async () => {
    await mountAt('desktop');
    expect(
      screen.getByText('The Way of Kings by Brandon Sanderson, read by Michael Kramer.'),
    ).toBeTruthy();
  });

  it('shows a page-shaped skeleton while loading, and an error with retry', async () => {
    mockBook = undefined;
    mockBookLoading = true;
    await mountAt('desktop');
    expect(screen.getByTestId('book-skeleton')).toBeTruthy();

    mockBookLoading = false;
    await mountAt('desktop');
    expect(screen.getByText('Could not load this book.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('takes a very long CJK title', async () => {
    mockBook = { ...BOOK, title: '三体'.repeat(40), series: '' };
    await mountAt('phone', 400);
    expect(screen.getByRole('header')).toHaveTextContent('三体'.repeat(40));
  });
});
