import { type InfiniteData, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { type ReactElement, type ReactNode, type Ref, useState } from 'react';
import { Platform, type ScrollView, type ScrollViewProps } from 'react-native';

import type {
  Book,
  BookMeta,
  Bookmark,
  BridgeJob,
  ChaptersResponse,
  Listing,
  Progress,
  User,
} from '@/api/types';
import type { LayoutClass } from '@/lib/layout';
import { mountWithPortal } from '@/testing/render-overlay';

// The book page over stand-ins for its data (the hooks), the player (the shared store
// double) and the sections other suites own. What it pins: the primary action per state
// (and that it never restarts the loaded book), the layout by the MEASURED width, the
// hero's place, the Chapters tab's whole-book timeline for a book that is NOT playing,
// the Details tab, an unmatched book reading complete, and the load and error states.

const mockPush = jest.fn();
const mockSetParams = jest.fn();
let mockParams: Record<string, unknown> = { libraryId: '1', path: ['Author', 'Book'] };
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h), setParams: (p: unknown) => mockSetParams(p) },
  useIsFocused: () => true,
  useLocalSearchParams: () => mockParams,
}));

let mockBook: Book | undefined;
let mockBookLoading = false;
let mockBookError: unknown = null;
const mockBookArgs = jest.fn();
let mockChapters: ChaptersResponse | undefined;
let mockProgress: Progress | null = null;
let mockMeta: BookMeta | undefined;
let mockCaps: Record<string, boolean> = {};
let mockBridge: { version: string; features: string[] } | undefined;
let mockJobs: BridgeJob[] = [];
const mockMetaArgs = jest.fn();
const mockProgressArgs = jest.fn();
const mockFavouriteCid = jest.fn();
let mockScope = 'home';
const mockRefetch = jest.fn();
let mockPodcastLibrary = false;
let mockLibraries: { id: number; name: string }[] | undefined = [{ id: 1, name: 'Fiction' }];
jest.mock('@/components/podcasts/episode-page', () => ({
  EpisodePage: ({ path }: { path: string }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text>{`Episode page for ${path}`}</Text>;
  },
}));
jest.mock('@/api/hooks', () => ({
  ...jest.requireActual('@/api/hooks'),
  useIsPodcastLibrary: () => mockPodcastLibrary,
  useBook: (...args: unknown[]) => {
    mockBookArgs(...args);
    return {
      data: mockBook,
      isLoading: mockBookLoading,
      error: mockBookError,
      refetch: mockRefetch,
    };
  },
  useChapters: () => ({ data: mockChapters, isLoading: false }),
  useLibraries: () => ({ data: mockLibraries }),
  useCapability: (flag: string) => mockCaps[flag] ?? false,
  useServerInfo: () => ({ data: { capabilities: mockCaps, bridge: mockBridge }, isError: false }),
  useBridgeJobs: (
    _l: number,
    _p: string,
    opts: { enabled: boolean; select?: (jobs: BridgeJob[]) => unknown },
  ) =>
    opts.enabled
      ? { data: opts.select ? opts.select(mockJobs) : mockJobs, isSuccess: true }
      : { data: undefined, isSuccess: false },
  useBookMeta: (...args: unknown[]) => {
    mockMetaArgs(...args);
    return { data: mockMeta };
  },
  useBookProgress: (...args: unknown[]) => {
    mockProgressArgs(...args);
    return { data: mockProgress, isPending: false };
  },
  useFavourites: () => ({ data: [] }),
  useToggleFavourite: (cid?: string) => {
    mockFavouriteCid(cid);
    return { mutate: jest.fn() };
  },
  useQueue: () => ({ data: undefined }),
  useRating: () => ({ data: null }),
  useMyRatings: () => ({ data: [], isError: false }),
  useSetRating: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => null,
  // The route's scope ('' for a link without `?connection=`) falls back to the default.
  useCid: (id?: string) => id ?? (mockScope || 'home'),
  useScopedCid: () => mockScope,
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
jest.mock('@/components/house/in-the-house-card', () => ({
  InTheHouseCard: ({ libraryId, path }: { libraryId: number; path: string }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text>{`In the house: ${libraryId}/${path}`}</Text>;
  },
}));
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
const mockIsDownloaded = jest.fn((_cid: string, _libraryId: number, _path: string) => false);
jest.mock('@/downloads/store', () => ({
  useIsDownloaded: (cid: string, libraryId: number, path: string) =>
    mockIsDownloaded(cid, libraryId, path),
  useDownloadedEbook: () => undefined,
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';
import { qk } from '@/api/hooks';
import { ADMIN, bridgeJob } from '@/testing/bridge-fixtures';
import { playerStoreMock } from '@/testing/player-store-mock';
import { useLibraryNames } from '@/stores/library-names';
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
async function mountAt(
  layout: LayoutClass,
  width?: number,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  mockLayout = layout;
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
  mockPodcastLibrary = false;
  mockLibraries = [{ id: 1, name: 'Fiction' }];
  useLibraryNames.setState({ names: {} });
  mockBookLoading = false;
  mockBookError = null;
  mockBookArgs.mockClear();
  mockChapters = CHAPTERS;
  mockProgress = null;
  mockMeta = undefined;
  mockCaps = {};
  mockBridge = undefined;
  mockJobs = [];
  mockMetaArgs.mockClear();
  mockProgressArgs.mockClear();
  mockFavouriteCid.mockClear();
  mockScope = 'home';
  mockSetParams.mockClear();
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

// Bridge Phase 2d-1: an episode gets its own page at the same link.
describe('book page, a podcast episode', () => {
  it('renders the episode page for an item that is an episode', async () => {
    mockBook = {
      ...BOOK,
      episode: {
        show_path: 'Author',
        published: null,
        season: null,
        episode: null,
        episode_type: 'full',
        explicit: false,
        downloaded: true,
        duration_source: 'file',
        removed: false,
      },
    };
    await mountAt('desktop');
    expect(screen.getByText('Episode page for Author/Book')).toBeTruthy();
    expect(screen.queryByTestId('book-page')).toBeNull();
  });

  it('renders it for any item of a podcast library, before the item is in', async () => {
    mockPodcastLibrary = true;
    mockBook = undefined;
    mockBookLoading = true;
    await mountAt('desktop');
    expect(screen.getByText('Episode page for Author/Book')).toBeTruthy();
  });

  it('keeps the book page for a book', async () => {
    await mountAt('desktop');
    expect(screen.queryByText(/Episode page/)).toBeNull();
    expect(screen.getByTestId('book-page')).toBeTruthy();
  });
});

// CONNECT-03: a book that did not load because the session ended is the sign-in state.
describe('book page, signed out', () => {
  it('shows the sign-in state, and no Retry, when the session ended', async () => {
    useSession.setState({
      connections: [
        {
          id: 'home',
          name: 'Hearthside',
          serverUrl: 'https://h',
          token: 't',
          needsReconnect: 'auth',
        },
      ],
    } as never);
    mockBook = undefined;
    await mountAt('desktop');
    expect(screen.getByText('Sign in again to Hearthside')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(screen.queryByText('Could not load this book.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('keeps the error with a Retry while signed in', async () => {
    mockBook = undefined;
    await mountAt('desktop');
    expect(screen.getByText('Could not load this book.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

// CONNECT-13: a book the server answers 404, 403 or 400 for isn't in the library; Retry
// can't help. frontend#129: a link that can't name a book asks nothing.
describe('a book that is not in the library', () => {
  it.each([404, 403, 400])('shows not-in-library with Back and Home for a %i', async (status) => {
    mockBook = undefined;
    mockBookError = new ApiError(status, 'nope');
    await mountAt('desktop');
    expect(screen.getByText("This book isn't in the library")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go to Home' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it.each([
    ['a library id that is not a number', { libraryId: 'abc', path: 'Author/Book' }],
    ['no path', { libraryId: '1' }],
  ])('asks nothing for %s', async (_name, params) => {
    mockParams = params;
    await mountAt('desktop');
    expect(screen.getByText("This book isn't in the library")).toBeTruthy();
    expect(mockBookArgs).not.toHaveBeenCalled();
  });
});

// A link without `?connection=` is the default server's book, never a blank page.
describe('book page without a connection param', () => {
  it("acts on the default server's book", async () => {
    mockScope = '';
    await mountAt('desktop');
    expect(screen.getByTestId('book-page')).toBeTruthy();
    expect(mockFavouriteCid).toHaveBeenCalledWith('home');
    expect(mockFavouriteCid).not.toHaveBeenCalledWith('');
  });
});

// frontend#130: path is the identity (CROSS-REPO section 1).
describe('book page, a track file path', () => {
  it("moves the route to the book's path before any place is read under the file's", async () => {
    mockParams = { libraryId: '1', path: 'Author/Book/book.m4b' };
    mockProgress = progressAt(1500);
    await mountAt('desktop');
    expect(mockSetParams).toHaveBeenCalledWith({ path: 'Author/Book' });
    expect(screen.queryByTestId('book-page')).toBeNull();
    expect(mockProgressArgs).not.toHaveBeenCalled();

    // The route now names the book: the page, with the book's place.
    mockParams = { libraryId: '1', path: 'Author/Book' };
    await screen.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <BookScreen />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('book-page')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume chapter 2' })).toBeTruthy();
    expect(mockProgressArgs.mock.calls.every(([, path]) => path === 'Author/Book')).toBe(true);
    expect(mockSetParams).toHaveBeenCalledTimes(1);
  });

  it('asks for no place under the file path while the item is still on its way', async () => {
    mockParams = { libraryId: '1', path: 'Author/Book/book.m4b' };
    mockBook = undefined;
    mockBookLoading = true;
    await mountAt('desktop');
    expect(mockProgressArgs).toHaveBeenCalled();
    expect(mockProgressArgs.mock.calls.every(([, , enabled]) => enabled === false)).toBe(true);
  });

  it('leaves the route alone for the book path', async () => {
    await mountAt('desktop');
    expect(mockSetParams).not.toHaveBeenCalled();
    expect(screen.getByTestId('book-page')).toBeTruthy();
  });
});

// server#193: the browse row opened a folder the scan had not reached (`pending_book`),
// and this page's read indexed it, so the listing that flagged it is read again.
describe('book page, a folder the scan had not reached', () => {
  // gcTime Infinity: a seeded entry holds no collection timer past the test.
  const cacheClient = () =>
    new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const listing = (pending: boolean): InfiniteData<Listing> => ({
    pageParams: [0],
    pages: [
      {
        path: 'Author',
        entries: [
          {
            name: 'Book',
            path: 'Author/Book',
            is_dir: true,
            is_audio: false,
            size: 0,
            mod_time: 0,
            ...(pending ? { pending_book: true } : { is_book: true }),
          },
        ],
        total: 1,
        offset: 0,
      },
    ],
  });

  it('marks the listing that flagged it stale, so going back shows its title', async () => {
    const client = cacheClient();
    client.setQueryData(qk.browse('home', 1, 'Author'), listing(true));
    await mountAt('desktop', undefined, client);
    expect(client.getQueryState(qk.browse('home', 1, 'Author'))?.isInvalidated).toBe(true);
  });

  it('leaves a listing alone that already held the book', async () => {
    const client = cacheClient();
    client.setQueryData(qk.browse('home', 1, 'Author'), listing(false));
    await mountAt('desktop', undefined, client);
    expect(client.getQueryState(qk.browse('home', 1, 'Author'))?.isInvalidated).toBe(false);
  });
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

  // Another device (or the other app on this phone) moved the saved place on while this
  // one held the book loaded and paused. The press toggles the loaded book in place, so
  // it plays from the PLAYER's place: the button and the hero must name that one, as the
  // time left beside them already does, not the higher saved one.
  it('names the loaded book by the place a press plays from, not a further saved one', async () => {
    mockProgress = progressAt(2500);
    player.patch({
      nowPlaying: THIS_BOOK as never,
      bookPosition: 500,
      snapshot: { ...player.usePlayer.getState().snapshot, state: 'paused' },
    });
    await mountAt('desktop');
    expect(screen.getByRole('button', { name: 'Resume chapter 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume chapter 3' })).toBeNull();
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

  it("reads the download under the book's rel_path, the key the download was kept under", async () => {
    mockBook = { ...BOOK, rel_path: 'Author/Book/' };
    await mountAt('desktop');
    expect(mockIsDownloaded).toHaveBeenLastCalledWith('home', 1, 'Author/Book/');
  });
});

describe('book page aside', () => {
  it('asks the In the house card about this book', async () => {
    await mountAt('desktop');
    expect(screen.getByText('In the house: 1/Author/Book')).toBeTruthy();
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

  it('opens each series a book is in from its own part of the eyebrow', async () => {
    mockBook = {
      ...BOOK,
      series_list: [
        { name: 'The Stormlight Archive', position: 1 },
        { name: 'The Cosmere', position: 4 },
      ],
    };
    await mountAt('desktop');
    await fireEvent.press(screen.getByRole('link', { name: 'Open the series The Cosmere' }));
    expect(mockPush).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pathname: '/series',
        params: expect.objectContaining({ name: 'The Cosmere' }),
      }),
    );
  });

  it('keeps a narrator without a page as plain text', async () => {
    mockCaps = { browse_people: false };
    await mountAt('desktop');
    expect(screen.queryByRole('link', { name: 'Books read by Michael Kramer' })).toBeNull();
    expect(screen.getByText('Michael Kramer')).toBeTruthy();
  });
});

// PLAYER-08/09: the crumbs end in the book's title, and offline name the library as the
// server last listed it.
describe('book page crumbs', () => {
  const crumbText = () =>
    within(screen.getByTestId('book-crumbs'))
      .getAllByText(/./)
      .map((n) => n.props.children as string);

  it("end in the book's title, not its folder name", async () => {
    await mountAt('phone', 390);
    expect(crumbText()).toEqual(['Fiction', 'Author', 'The Way of Kings']);
    const last = within(screen.getByTestId('book-crumbs')).getByText('The Way of Kings');
    expect(last.props.numberOfLines).toBe(1);
  });

  it('name the library as the server last listed it while the list cannot be read', async () => {
    mockLibraries = undefined;
    useLibraryNames.setState({ names: { home: { '1': 'Books' } } });
    await mountAt('desktop');
    expect(crumbText()[0]).toBe('Books');
    expect(screen.queryByText('Library')).toBeNull();
  });

  it('fall back to "Library" for a library never listed on this device', async () => {
    mockLibraries = undefined;
    useLibraryNames.setState({ names: { other: { '1': 'Books' } } });
    await mountAt('desktop');
    expect(crumbText()[0]).toBe('Library');
  });

  it('prefer the live name over the kept one', async () => {
    useLibraryNames.setState({ names: { home: { '1': 'Old name' } } });
    await mountAt('desktop');
    expect(crumbText()[0]).toBe('Fiction');
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

  it('says the chapters come from the community only when the server says so', async () => {
    await mountAt('desktop');
    expect(screen.queryByTestId('book-chapters-community')).toBeNull();
    expect(screen.queryByText('Chapters from the AudioSilo community database')).toBeNull();

    mockChapters = { ...CHAPTERS, chapters_source: 'community' };
    await mountAt('desktop');
    expect(screen.getByText('Chapters from the AudioSilo community database')).toBeTruthy();
    expect(screen.queryByTestId('book-chapters-generated')).toBeNull();
    // The rows are the chapters as ever.
    expect(screen.getByRole('button', { name: /^Stormblessed/ })).toBeTruthy();

    // Parts the player makes are not the community's list: no caption under them.
    mockBook = { ...BOOK, duration: 2 * 3600 };
    mockChapters = { ...CHAPTERS, duration: 2 * 3600, chapters: [], chapters_source: 'community' };
    await mountAt('desktop');
    expect(screen.getByText('This book has no chapter marks')).toBeTruthy();
    expect(screen.queryByTestId('book-chapters-community')).toBeNull();
  });

  // Bridge Phase 1d: chapters a Bridge found in the narration say so, never as the
  // community's.
  it('says the chapters were found in the narration when the server says generated', async () => {
    mockChapters = { ...CHAPTERS, chapters_source: 'generated' };
    await mountAt('desktop');
    expect(screen.getByTestId('book-chapters-generated')).toBeTruthy();
    expect(screen.getByText('Chapters found in the narration on this server')).toBeTruthy();
    expect(screen.queryByTestId('book-chapters-community')).toBeNull();
    expect(screen.getByRole('button', { name: /^Stormblessed/ })).toBeTruthy();

    // Parts the player makes are not the detected list: no caption under them.
    mockBook = { ...BOOK, duration: 2 * 3600 };
    mockChapters = { ...CHAPTERS, duration: 2 * 3600, chapters: [], chapters_source: 'generated' };
    await mountAt('desktop');
    expect(screen.getByText('This book has no chapter marks')).toBeTruthy();
    expect(screen.queryByTestId('book-chapters-generated')).toBeNull();
  });

  // A newer server may name a source this build does not know: no caption, never a raw
  // translation key.
  it('shows no source caption for a chapters source it does not know', async () => {
    mockChapters = { ...CHAPTERS, chapters_source: 'edited' };
    await mountAt('desktop');
    expect(screen.queryByTestId('book-chapters-community')).toBeNull();
    expect(screen.queryByTestId('book-chapters-generated')).toBeNull();
    expect(screen.queryByText(/book\.chapters\./)).toBeNull();
    expect(screen.getByRole('button', { name: /^Stormblessed/ })).toBeTruthy();
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

describe('book page Bridge (generated characters and recaps)', () => {
  const signIn = (user: User) =>
    useSession.setState({
      connections: [{ id: 'home', name: 'Hearthside', serverUrl: 'https://h', token: 't', user }],
    } as never);
  const bridgeOn = () => {
    mockCaps = { metadata: true, bridge: true };
    mockBridge = { version: '0.2.0', features: ['sidecars'] };
  };
  const characters = [{ id: 'ada', name: 'Ada Quill', reveal: { chapter: 1 } }];
  const recaps = [{ through: { chapter: 0 }, text: 'Before the book begins.' }];

  // A book the community doesn't know (no match), whose characters and recaps the Bridge
  // generated on this server: the server answers matched:false with a work.
  it("shows an unmatched book's generated characters and recaps, marked as generated", async () => {
    mockCaps = { metadata: true };
    // No ASIN or ISBN: the server's `generated` flag is what asks for its /meta.
    mockBook = { ...BOOK, generated: true };
    mockMeta = {
      matched: false,
      work: {
        id: '',
        title: 'The Way of Kings',
        authors: [],
        language: '',
        characters,
        recaps,
        generated: { characters: true, recaps: true },
      },
    };
    await mountAt('desktop');
    expect(screen.getByTestId('book-tab-characters')).toBeTruthy();
    expect(screen.getByTestId('book-tab-recaps')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('book-tab-characters'));
    expect(screen.getByText('Ada Quill')).toBeTruthy();
    expect(screen.getByText('Generated on this server')).toBeTruthy();
    // No community credit for generated content, and no AudioSilo Meta link.
    expect(screen.queryByText(/CC BY-SA/)).toBeNull();
    expect(screen.queryByText('View on AudioSilo Meta')).toBeNull();
  });

  // Bridge 1c: an unmatched book whose only generated content is its description.
  it("shows an unmatched book's generated description in About, marked", async () => {
    mockCaps = { metadata: true };
    mockBook = { ...BOOK, generated: true, description: undefined };
    mockMeta = {
      matched: false,
      work: {
        id: '',
        title: 'The Way of Kings',
        authors: [],
        language: '',
        generated_description: { text: 'A storm-wracked world, told from its opening.' },
        generated: { description: true },
      },
    };
    await mountAt('desktop');
    expect(screen.getByText('A storm-wracked world, told from its opening.')).toBeTruthy();
    expect(screen.getByTestId('about-generated-mark')).toBeTruthy();
    // A description alone opens no Characters or Recaps tab.
    expect(screen.queryByTestId('book-tab-characters')).toBeNull();
    expect(screen.queryByTestId('book-tab-recaps')).toBeNull();
    expect(screen.queryByText('View on AudioSilo Meta')).toBeNull();
  });

  // One Bridge run writes all three: About's chip and the open panel's are told apart.
  it("marks About's generated description and the generated panel each on its own", async () => {
    mockCaps = { metadata: true };
    mockBook = { ...BOOK, generated: true, description: undefined };
    mockMeta = {
      matched: false,
      work: {
        id: '',
        title: 'The Way of Kings',
        authors: [],
        language: '',
        characters,
        recaps,
        generated_description: { text: 'A storm-wracked world, told from its opening.' },
        generated: { characters: true, recaps: true, description: true },
      },
    };
    await mountAt('desktop');
    await fireEvent.press(screen.getByTestId('book-tab-characters'));
    expect(screen.getByTestId('about-generated-mark')).toBeTruthy();
    expect(screen.getByTestId('generated-mark')).toBeTruthy();
    expect(screen.getAllByText('Generated on this server')).toHaveLength(2);
  });

  it('marks only the dimension that was generated', async () => {
    mockCaps = { metadata: true };
    mockBook = { ...BOOK, asin: 'B0' };
    mockMeta = {
      matched: true,
      work: {
        id: 'w',
        title: 'The Way of Kings',
        authors: [],
        language: 'en',
        characters,
        recaps,
        generated: { characters: true },
      },
      web_url: 'https://meta.audiosilo.app/work?id=w',
    };
    await mountAt('desktop');
    await fireEvent.press(screen.getByTestId('book-tab-characters'));
    expect(screen.getByTestId('generated-mark')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('book-tab-recaps'));
    expect(screen.queryByTestId('generated-mark')).toBeNull();
  });

  // /meta is keyed by the book's own path, as every other surface (and a finished
  // Bridge job's refresh) keys it, whatever path the route was opened with.
  it("asks /meta by the book's own path, not the route's", async () => {
    mockCaps = { metadata: true };
    mockParams = { libraryId: '1', path: ['Author', 'Book', 'Disc 1'] };
    mockBook = { ...BOOK, asin: 'B0' };
    await mountAt('desktop');
    // The route moves to the book's own path first (frontend#130), then the page asks.
    expect(mockSetParams).toHaveBeenCalledWith({ path: 'Author/Book' });
    expect(mockMetaArgs).not.toHaveBeenCalled();
    mockParams = { libraryId: '1', path: 'Author/Book' };
    await screen.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <BookScreen />
      </QueryClientProvider>,
    );
    expect(mockMetaArgs).toHaveBeenLastCalledWith(1, 'Author/Book', true);
  });

  it('never asks /meta for a book with no ASIN or ISBN and nothing generated', async () => {
    mockCaps = { metadata: true };
    await mountAt('desktop');
    expect(mockMetaArgs).toHaveBeenLastCalledWith(1, 'Author/Book', false);
  });

  it('keeps an unmatched book with nothing generated as before: no community tabs', async () => {
    mockCaps = { metadata: true };
    mockBook = { ...BOOK, asin: 'B0' };
    mockMeta = { matched: false };
    await mountAt('desktop');
    expect(screen.queryByTestId('book-tab-characters')).toBeNull();
    expect(screen.queryByTestId('book-tab-recaps')).toBeNull();
  });

  it('offers an admin "Generate characters and recaps" for a book with neither', async () => {
    signIn(ADMIN);
    bridgeOn();
    mockMeta = { matched: false };
    await mountAt('desktop');
    await fireEvent.press(screen.getByTestId('generate-action'));
    // The confirmation opens (its estimate is the Bridge suite's business).
    expect(screen.getByText('The Bridge reads The Way of Kings', { exact: false })).toBeTruthy();
  });

  it('never offers it to a non-admin, nor on a server whose Bridge lacks sidecars', async () => {
    signIn({ ...ADMIN, role: 'user' });
    bridgeOn();
    mockMeta = { matched: false };
    await mountAt('desktop');
    expect(screen.queryByTestId('generate-action')).toBeNull();

    signIn(ADMIN);
    mockBridge = { version: '0.1.0', features: ['verify'] };
    await mountAt('desktop');
    expect(screen.queryByTestId('generate-action')).toBeNull();
  });

  // Its Generate could send nothing once the person may not generate (the Bridge went
  // offline: the flag is off), and it must not come back by itself afterwards.
  it('closes the confirmation with the permission, and keeps it closed', async () => {
    signIn(ADMIN);
    bridgeOn();
    mockMeta = { matched: false };
    await mountAt('desktop');
    await fireEvent.press(screen.getByTestId('generate-action'));
    const lead = 'The Bridge reads The Way of Kings';
    expect(screen.getByText(lead, { exact: false })).toBeTruthy();
    await act(async () => {
      signIn({ ...ADMIN, role: 'user' });
    });
    expect(screen.queryByText(lead, { exact: false })).toBeNull();
    await act(async () => {
      signIn(ADMIN);
    });
    expect(screen.queryByText(lead, { exact: false })).toBeNull();
  });

  // Bridge Phase 1e: one offer rule with the console. A matched work the community gives
  // both characters and recaps offers no Generate; an admin is told why, with a link to
  // the Characters tab.
  const covered = (): BookMeta => ({
    matched: true,
    work: { id: 'w', title: 'The Way of Kings', authors: [], language: 'en', characters, recaps },
    web_url: 'https://meta.audiosilo.app/work?id=w',
  });

  it('tells an admin the community covers a book, and opens its Characters tab', async () => {
    signIn(ADMIN);
    bridgeOn();
    mockBook = { ...BOOK, asin: 'B0' };
    mockMeta = covered();
    await mountAt('desktop');
    expect(
      screen.getByText('The community already has characters and recaps for this book'),
    ).toBeTruthy();
    expect(screen.queryByTestId('generate-action')).toBeNull();
    expect(screen.queryByText('Ada Quill')).toBeNull();
    await fireEvent.press(screen.getByTestId('generate-covered-open'));
    expect(screen.getByText('Ada Quill')).toBeTruthy();
  });

  // react-native-web's ScrollView gives a forwarded ref its node only at mount (its host
  // ref callback is a stable instance method), unlike the native mock: emulated for this
  // test alone, so a ref the page first passes on an update stays null as it does on the
  // web. The skeleton mounts the scroller, so the ref must already ride on it.
  it('scrolls the Characters tab into view from the covered line after the book loads', async () => {
    const RN = jest.requireActual<typeof import('react-native')>('react-native');
    const NativeScrollView = RN.ScrollView;
    function MountRefScrollView({ ref, ...props }: ScrollViewProps & { ref?: Ref<ScrollView> }) {
      const [mountRef] = useState(() => ref);
      return <NativeScrollView {...props} ref={mountRef} />;
    }
    const scrollView = jest
      .spyOn(RN, 'ScrollView', 'get')
      .mockReturnValue(MountRefScrollView as unknown as typeof NativeScrollView);
    const scrollTo = jest.mocked(NativeScrollView.prototype.scrollTo);
    const { default: nativeMethods } = jest.requireActual<{
      default: { measureLayout: jest.Mock };
    }>('@react-native/jest-preset/jest/MockNativeMethods');
    scrollTo.mockClear();
    nativeMethods.measureLayout.mockImplementation(
      (_to: unknown, success: (x: number, y: number) => void) => success(0, 640),
    );
    try {
      signIn(ADMIN);
      bridgeOn();
      mockMeta = covered();
      mockBook = undefined;
      mockBookLoading = true;
      await mountAt('desktop');
      expect(screen.getByTestId('book-skeleton')).toBeTruthy();
      mockBook = { ...BOOK, asin: 'B0' };
      mockBookLoading = false;
      // A new user object re-renders the page (its Generate model reads the session).
      await act(async () => signIn({ ...ADMIN }));
      await fireEvent.press(screen.getByTestId('generate-covered-open'));
      await waitFor(() =>
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ y: 640 })),
      );
    } finally {
      scrollView.mockRestore();
      nativeMethods.measureLayout.mockReset();
    }
  });

  it('never shows a listener the covered line', async () => {
    signIn({ ...ADMIN, role: 'user' });
    bridgeOn();
    mockBook = { ...BOOK, asin: 'B0' };
    mockMeta = covered();
    await mountAt('desktop');
    expect(screen.queryByTestId('generate-covered')).toBeNull();
    expect(screen.queryByTestId('generate-action')).toBeNull();
  });

  it('offers Generate for a book the community has characters but no recaps for', async () => {
    signIn(ADMIN);
    bridgeOn();
    mockBook = { ...BOOK, asin: 'B0' };
    const meta = covered();
    mockMeta = { ...meta, work: { ...meta.work!, recaps: [] } };
    await mountAt('desktop');
    expect(screen.getByTestId('generate-action')).toBeTruthy();
    expect(screen.queryByTestId('generate-covered')).toBeNull();
  });

  it('shows the running job where the action was', async () => {
    signIn(ADMIN);
    bridgeOn();
    mockMeta = { matched: false };
    mockJobs = [bridgeJob({ id: 4, progress: { step: 'fact_pass' } })];
    await mountAt('desktop');
    expect(screen.getByTestId('generate-status')).toBeTruthy();
    expect(screen.getByText('Reading for facts')).toBeTruthy();
    expect(screen.queryByTestId('generate-action')).toBeNull();
  });

  // Bridge Phase 1e: a community whole-book summary beside a recap list generated here
  // keeps its credit, and only the list wears the generated mark.
  it('keeps a community summary credited beside generated recaps', async () => {
    mockCaps = { metadata: true };
    mockBook = { ...BOOK, asin: 'B0' };
    mockMeta = {
      matched: true,
      work: {
        id: 'w',
        title: 'The Way of Kings',
        authors: [],
        language: 'en',
        recaps,
        recap_summary: { in_short: 'The whole book, ending included.' },
        generated: { recaps: true, recap_summary: false },
        attribution: {
          credit: 'AudioSilo Meta community contributors',
          license: 'CC BY-SA 4.0',
          license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
          source_url: 'https://meta.audiosilo.app/work?id=w',
        },
      },
      web_url: 'https://meta.audiosilo.app/work?id=w',
    };
    await mountAt('desktop');
    await fireEvent.press(screen.getByTestId('book-tab-recaps'));
    expect(screen.getByTestId('recaps-generated-mark')).toBeTruthy();
    expect(screen.queryByTestId('summary-generated-mark')).toBeNull();
    expect(screen.queryByTestId('generated-mark')).toBeNull();
    expect(screen.getByText(/Community notes from/)).toBeTruthy();
  });

  // A matched work keeps its community credit for what the community wrote (here its
  // characters); the recaps generated on this server carry none of it.
  it('credits the community under its own dimension only', async () => {
    mockCaps = { metadata: true };
    mockBook = { ...BOOK, asin: 'B0' };
    mockMeta = {
      matched: true,
      work: {
        id: 'w',
        title: 'The Way of Kings',
        authors: [],
        language: 'en',
        characters,
        recaps,
        generated: { recaps: true },
        attribution: {
          credit: 'AudioSilo Meta community contributors',
          license: 'CC BY-SA 4.0',
          license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
          source_url: 'https://meta.audiosilo.app/work?id=w',
        },
      },
      web_url: 'https://meta.audiosilo.app/work?id=w',
    };
    await mountAt('desktop');
    await fireEvent.press(screen.getByTestId('book-tab-recaps'));
    expect(screen.getByTestId('generated-mark')).toBeTruthy();
    expect(screen.queryByText(/Community notes from/)).toBeNull();
    await fireEvent.press(screen.getByTestId('book-tab-characters'));
    expect(screen.queryByTestId('generated-mark')).toBeNull();
    expect(screen.getByText(/Community notes from/)).toBeTruthy();
  });
});
