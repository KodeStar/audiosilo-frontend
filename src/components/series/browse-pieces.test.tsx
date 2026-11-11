import { fireEvent, render, screen } from '@testing-library/react-native';

import type { Book, PeopleList } from '@/api/types';
import { settleFlashList } from '@/testing/flash-list';

const mockPush = jest.fn();
const mockSetParams = jest.fn();
// A tile's actions menu (book actions, the player) has its own tests.
jest.mock('@/components/library/tile-actions', () => ({ TileActions: () => null }));
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h), setParams: (p: unknown) => mockSetParams(p) },
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/downloads/store', () => ({
  useIsDownloaded: () => false,
  useDownloadedCoverUri: () => null,
  useDownloads: (select: (s: object) => unknown) => select({ supported: true }),
}));
let mockDeviceOnline = true;
jest.mock('@/lib/device-online', () => ({
  ...jest.requireActual('@/lib/device-online'),
  useDeviceOnline: () => mockDeviceOnline,
}));
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'desktop',
}));
jest.mock('@/api/provider', () => ({
  useCid: () => 'home',
  useOptionalApi: () => ({ coverUrl: () => 'https://s/c', authHeaders: () => ({}) }),
}));
jest.mock('@/stores/session', () => ({
  useSession: (sel: (s: unknown) => unknown) =>
    sel({ connections: [{ id: 'home', name: 'Home Library' }] }),
  useConnectionName: (id: string) => (id === 'home' ? 'Home Library' : ''),
}));
let mockCaps: Record<string, boolean | undefined> = {};
let mockSeries: {
  isPending: boolean;
  isPaused?: boolean;
  error?: unknown;
  data?: unknown;
  refetch: jest.Mock;
};
let mockBooks: {
  books: Book[];
  isLoading: boolean;
  isIdle: boolean;
  offline?: boolean;
  error: unknown;
  retry: jest.Mock;
};
jest.mock('@/api/hooks', () => ({
  useSavedProgress: () => undefined,
  useServerInfo: () => ({ data: { capabilities: {} } }),
  useCapability: (flag: string) => mockCaps[flag],
  useLibraryBooks: () => ({ data: undefined }),
  useSeriesList: () => ({ isPaused: false, error: null, ...mockSeries }),
  useAllLibraryBooks: () => mockBooks,
  useProgressLookup: () => ({ progressOf: () => undefined, isLoading: false }),
}));

/* eslint-disable import/first */
import { GhostCover } from '@/components/library/ghost-cover';
import { SeriesMode } from '@/components/library/modes/series-mode';

import { cardItems } from './card-grid';
import { PeopleMode } from './people-mode';
import { PersonPage } from './person-page';
import { Spine } from './spine';
/* eslint-enable import/first */

const layoutEvent = { nativeEvent: { layout: { width: 1200, height: 800 } } };

beforeEach(() => {
  mockPush.mockClear();
  mockSetParams.mockClear();
  mockCaps = { browse_people: true };
});

describe('Spine', () => {
  it('is a button named by its full title, which picks it', async () => {
    const onPress = jest.fn();
    const title = 'The Remarkably Long and Occasionally Tedious Account of a Lighthouse Keeper';
    await render(
      <Spine
        title={title}
        position="1"
        width={26}
        height={180}
        scale={1}
        variant="book"
        onPress={onPress}
        accessibilityLabel={`Book 1, ${title}`}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: `Book 1, ${title}` }));
    expect(onPress).toHaveBeenCalled();
  });

  it('is decoration without a press (the mini shelves)', async () => {
    await render(<Spine title="Dune" width={30} height={180} scale={1} variant="ghost" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('GhostCover as a thumbnail', () => {
  it('drops the note below 100 wide but keeps it in the name', async () => {
    await render(<GhostCover title="Cibola Burn" position="4" width={72} />);
    expect(
      screen.getByRole('image', { name: 'Book 4, Cibola Burn, Not in your library' }),
    ).toBeTruthy();
    expect(screen.queryByText('Not in your library')).toBeNull();
  });
});

describe('cardItems', () => {
  it('adds A-Z heads only for a long list', () => {
    const names = ['Ann', 'Bob', 'Cy'];
    expect(cardItems(names, (n) => n).map((r) => r.kind)).toEqual(['item', 'item', 'item']);
    const many = Array.from({ length: 70 }, (_, i) => (i < 35 ? `A${i}` : `B${i}`));
    const items = cardItems(many, (n) => n);
    expect(items[0]).toEqual({ kind: 'head', letter: 'A' });
    expect(items.filter((r) => r.kind === 'head')).toHaveLength(2);
  });
});

/** Render a FlashList screen and let its first-load frame land inside act. */
async function show(ui: React.ReactElement) {
  const r = await render(ui);
  await settleFlashList();
  return r;
}

const OFFLINE_LIST =
  "This list shows once its server answers. Books you've downloaded are in Downloads.";
const OFFLINE_PAGE =
  "This page shows once its server answers. Books you've downloaded are in Downloads.";
beforeEach(() => {
  mockDeviceOnline = true;
});

describe('PeopleMode', () => {
  const list = (data?: PeopleList, isPending = false, state: { isPaused?: boolean } = {}) => ({
    data,
    isPending,
    isPaused: false,
    // Settled with nothing: the list failed.
    error: !data && !isPending ? new TypeError('Network request failed') : null,
    refetch: jest.fn(),
    ...state,
  });

  it('shows placeholders while the list loads', async () => {
    await show(
      <PeopleMode kind="author" connectionId="home" libraryId={1} list={list(undefined, true)} />,
    );
    expect(screen.getByTestId('people-mode-loading')).toBeTruthy();
  });

  it('lists people, opens one, and counts the unnamed books', async () => {
    await show(
      <PeopleMode
        kind="narrator"
        connectionId="home"
        libraryId={1}
        list={list({ people: [{ name: 'Kate Reading', books: 2, duration: 7200 }], unknown: 3 })}
      />,
    );
    await fireEvent(screen.getByTestId('card-grid'), 'layout', layoutEvent);
    await settleFlashList();
    await fireEvent.press(screen.getByRole('button', { name: 'Kate Reading, 2 books · 2h' }));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/narrator',
      params: { connection: 'home', library: '1', name: 'Kate Reading' },
    });
    expect(screen.getByText('3 books have no narrator listed.')).toBeTruthy();
  });

  it('says when there is nobody, and goes back to the books', async () => {
    await show(
      <PeopleMode
        kind="author"
        connectionId="home"
        libraryId={1}
        list={list({ people: [], unknown: 0 })}
      />,
    );
    expect(screen.getByText('No authors here yet')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Browse books' }));
    expect(mockSetParams).toHaveBeenCalledWith({ mode: undefined });
  });

  it('offers Retry when the list fails', async () => {
    const failed = list(undefined, false);
    await show(<PeopleMode kind="author" connectionId="home" libraryId={1} list={failed} />);
    expect(screen.queryByText("You're offline")).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(failed.refetch).toHaveBeenCalled();
  });

  // The list is held for the network (it stays pending): the placeholders never ended.
  it('says offline, not placeholders, while the list waits for the network', async () => {
    await show(
      <PeopleMode
        kind="author"
        connectionId="home"
        libraryId={1}
        list={list(undefined, true, { isPaused: true })}
      />,
    );
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.getByText(OFFLINE_LIST)).toBeTruthy();
    expect(screen.queryByTestId('people-mode-loading')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says offline, with no Retry, when the list failed with no network on the device', async () => {
    mockDeviceOnline = false;
    await show(
      <PeopleMode kind="narrator" connectionId="home" libraryId={1} list={list(undefined)} />,
    );
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('keeps showing the people it holds while it is offline', async () => {
    mockDeviceOnline = false;
    await show(
      <PeopleMode
        kind="narrator"
        connectionId="home"
        libraryId={1}
        list={list(
          { people: [{ name: 'Kate Reading', books: 2, duration: 7200 }], unknown: 0 },
          false,
          {
            isPaused: true,
          },
        )}
      />,
    );
    await fireEvent(screen.getByTestId('card-grid'), 'layout', layoutEvent);
    await settleFlashList();
    expect(screen.getByRole('button', { name: 'Kate Reading, 2 books · 2h' })).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });
});

describe('SeriesMode', () => {
  it('lists the series, opening one', async () => {
    mockBooks = { books: [], isLoading: true, isIdle: false, error: null, retry: jest.fn() };
    mockSeries = {
      isPending: false,
      data: [
        {
          name: 'Codex Alera',
          author: 'Jim Butcher',
          books: 3,
          duration: 15_300,
          positions: [1, 2, 4],
        },
      ],
      refetch: jest.fn(),
    };
    await show(<SeriesMode connectionId="home" libraryId={1} />);
    await fireEvent(screen.getByTestId('card-grid'), 'layout', layoutEvent);
    await settleFlashList();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Codex Alera, Jim Butcher · 4h 15m, 3 of 4' }),
    );
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/series',
      params: { connection: 'home', library: '1', name: 'Codex Alera' },
    });
  });

  it('has an empty state', async () => {
    mockSeries = { isPending: false, data: [], refetch: jest.fn() };
    await show(<SeriesMode connectionId="home" libraryId={1} />);
    expect(screen.getByText('No series here yet')).toBeTruthy();
  });

  it('shows placeholders while the list loads, and Retry when it fails', async () => {
    mockSeries = { isPending: true, refetch: jest.fn() };
    const loading = await show(<SeriesMode connectionId="home" libraryId={1} />);
    expect(screen.getByTestId('series-mode-loading')).toBeTruthy();
    await loading.unmount();
    mockSeries = { isPending: false, error: new TypeError('down'), refetch: jest.fn() };
    await show(<SeriesMode connectionId="home" libraryId={1} />);
    expect(screen.queryByText("You're offline")).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(mockSeries.refetch).toHaveBeenCalled();
  });

  // The list is held for the network (it stays pending): the placeholders never ended.
  it('says offline, not placeholders, while the list waits for the network', async () => {
    mockSeries = { isPending: true, isPaused: true, refetch: jest.fn() };
    await show(<SeriesMode connectionId="home" libraryId={1} />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.getByText(OFFLINE_LIST)).toBeTruthy();
    expect(screen.queryByTestId('series-mode-loading')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says offline, with no Retry, when the list failed with no network on the device', async () => {
    mockDeviceOnline = false;
    mockSeries = { isPending: false, error: new TypeError('down'), refetch: jest.fn() };
    await show(<SeriesMode connectionId="home" libraryId={1} />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('keeps showing the series it holds while it is offline', async () => {
    mockDeviceOnline = false;
    mockSeries = { isPending: false, isPaused: true, data: [], refetch: jest.fn() };
    await show(<SeriesMode connectionId="home" libraryId={1} />);
    expect(screen.getByText('No series here yet')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });
});

describe('PersonPage', () => {
  it("says a server without the narrator filter can't list a narrator's books", async () => {
    mockCaps = { browse_people: false };
    mockBooks = { books: [], isLoading: false, isIdle: true, error: null, retry: jest.fn() };
    await show(<PersonPage kind="narrator" libraryId={1} name="Kate Reading" />);
    expect(screen.getByText("This server can't list books by narrator yet")).toBeTruthy();
  });

  it('groups the books by series, opening the series page', async () => {
    const book = (title: string, series = '', index = 0): Book => ({
      id: 1,
      library_id: 1,
      rel_path: `JB/${title}`,
      is_folder: true,
      title,
      author: 'Jim Butcher',
      series,
      series_index: index,
      narrator: 'James Marsters',
      duration: 3600,
      format: 'm4b',
      size: 1,
    });
    mockBooks = {
      books: [book('Storm Front', 'The Dresden Files', 1), book('Standalone')],
      isLoading: false,
      isIdle: false,
      error: null,
      retry: jest.fn(),
    };
    await show(<PersonPage kind="author" libraryId={1} name="Jim Butcher" />);
    await fireEvent(screen.getByTestId('cover-grid'), 'layout', layoutEvent);
    expect(screen.getByRole('header', { name: 'Jim Butcher' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('link', { name: 'Open the series The Dresden Files' }));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/series',
      params: { connection: 'home', library: '1', name: 'The Dresden Files' },
    });
    expect(screen.getByText('Other books')).toBeTruthy();
    // Read by: narrator chips need browse_people (true here).
    expect(screen.getByRole('link', { name: 'James Marsters' })).toBeTruthy();
  });

  // The first page is held for the network, which counts as loading: the skeleton never
  // ended.
  it('says offline, not a skeleton, while the books wait for the network', async () => {
    mockCaps = { browse_people: true };
    mockBooks = {
      books: [],
      isLoading: true,
      isIdle: false,
      offline: true,
      error: null,
      retry: jest.fn(),
    };
    await show(<PersonPage kind="author" libraryId={1} name="Jim Butcher" />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.getByText(OFFLINE_PAGE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says offline with no Retry when they failed with no network, and Retry with one', async () => {
    mockCaps = { browse_people: true };
    mockBooks = {
      books: [],
      isLoading: false,
      isIdle: false,
      error: new TypeError('Network request failed'),
      retry: jest.fn(),
    };
    mockDeviceOnline = false;
    const offline = await show(<PersonPage kind="author" libraryId={1} name="Jim Butcher" />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await offline.unmount();

    mockDeviceOnline = true;
    await show(<PersonPage kind="author" libraryId={1} name="Jim Butcher" />);
    expect(screen.queryByText("You're offline")).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(mockBooks.retry).toHaveBeenCalled();
  });
});
