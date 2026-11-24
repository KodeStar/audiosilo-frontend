import { render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import type { SourcedFavourite } from '@/api/hooks';

jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openBook: jest.fn(), openLibrary: jest.fn() }),
}));
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'desktop',
}));
jest.mock('@/lib/use-page-title', () => ({ usePageTitle: () => undefined }));
jest.mock('@/downloads/store', () => ({
  useDownloads: (select: (s: object) => unknown) => select({ supported: true }),
}));
let mockDeviceOnline = true;
jest.mock('@/lib/device-online', () => ({
  ...jest.requireActual('@/lib/device-online'),
  useDeviceOnline: () => mockDeviceOnline,
}));
// The grid and its tiles have their own tests; here, which state the page is in and
// what each cover is handed (recorded by layout).
const mockCover = jest.fn((_layout: 'grid' | 'list', _props: { coverVersion?: string }) => null);
jest.mock('@/components/library/cover-grid', () => {
  const { Text, View } = jest.requireActual('react-native');
  return {
    CoverGrid: ({
      data,
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
    }: {
      data: readonly SourcedFavourite[];
      renderItem: (f: SourcedFavourite, tile: number) => ReactElement;
      ListHeaderComponent: ReactElement;
      ListEmptyComponent: ReactElement | null;
    }) => (
      <View>
        {ListHeaderComponent}
        {data.length === 0
          ? ListEmptyComponent
          : data.map((f) => (
              <View key={f.path}>
                <Text>{f.title}</Text>
                {renderItem(f, 120)}
              </View>
            ))}
      </View>
    ),
    CoverGridSkeleton: () => <Text>loading grid</Text>,
    CoverListRow: (p: { coverVersion?: string }) => mockCover('list', p),
  };
});
jest.mock('@/components/library/cover-tile', () => ({
  CoverTile: (p: { coverVersion?: string }) => mockCover('grid', p),
  useServerFlag: () => () => undefined,
}));
jest.mock('@/components/library/books/books-controls', () => ({ LayoutToggle: () => null }));
let mockBooksLayout: 'grid' | 'list' = 'grid';
jest.mock('@/components/library/books/books-layout-store', () => ({
  useBooksLayout: () => [mockBooksLayout, jest.fn()],
}));

type Favourites = {
  favourites: SourcedFavourite[];
  isLoading: boolean;
  offline: boolean;
  error: unknown;
  /** The failure of a server with nothing kept (`error` counts a failed re-read too). */
  unreadError: unknown;
};
let mockFavourites: Favourites;
jest.mock('@/api/hooks', () => ({
  useFavouritesAll: () => mockFavourites,
  useToggleFavourite: () => ({ mutate: jest.fn() }),
}));

/* eslint-disable import/first */
import { FavouritesScreen } from './favourites-screen';
/* eslint-enable import/first */

const book = {
  connectionId: 'home',
  connectionName: 'Hearthside',
  library_id: 1,
  path: 'Tolkien/The Hobbit',
  title: 'The Hobbit',
  is_book: true,
} as SourcedFavourite;

const read = (state: Partial<Favourites> = {}): Favourites => ({
  favourites: [],
  isLoading: false,
  offline: false,
  error: null,
  unreadError: null,
  ...state,
});

beforeEach(() => {
  mockDeviceOnline = true;
  mockFavourites = read();
  mockBooksLayout = 'grid';
  mockCover.mockClear();
});

describe('FavouritesScreen', () => {
  it('says there are none once every list is read with nothing in it', async () => {
    await render(<FavouritesScreen />);
    expect(screen.getByText('Tap the heart on a folder or book to add it here.')).toBeTruthy();
    expect(screen.getByText('0 items')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  // A held list is not loading (`isLoading` is false): it used to read as "no favourites".
  it('says offline, never "no favourites", while a list waits for the network', async () => {
    mockFavourites = read({ offline: true });
    await render(<FavouritesScreen />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.getByText(/This list shows once its server answers\./)).toBeTruthy();
    expect(screen.queryByText('Tap the heart on a folder or book to add it here.')).toBeNull();
    expect(screen.queryByText('0 items')).toBeNull();
  });

  it('says offline for a list that failed with no network, and names the failure with one', async () => {
    const down = new Error('Network request failed');
    mockFavourites = read({ error: down, unreadError: down });
    mockDeviceOnline = false;
    const view = await render(<FavouritesScreen />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByText("Couldn't load your favourites")).toBeNull();

    mockDeviceOnline = true;
    await view.rerender(<FavouritesScreen />);
    expect(screen.getByText("Couldn't load your favourites")).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
    // Not "0 items" over a list that was not read.
    expect(screen.queryByText('0 items')).toBeNull();
  });

  // fe#271: a kept list whose re-read failed read as "Couldn't load your favourites".
  it('says there are none for a list kept with nothing in it whose re-read failed', async () => {
    mockFavourites = read({ error: new Error('Network request failed') });
    await render(<FavouritesScreen />);
    expect(screen.getByText('Tap the heart on a folder or book to add it here.')).toBeTruthy();
    expect(screen.getByText('0 items')).toBeTruthy();
    expect(screen.queryByText("Couldn't load your favourites")).toBeNull();
  });

  it('keeps showing the favourites it holds when their re-read failed', async () => {
    mockFavourites = read({ favourites: [book], error: new Error('Network request failed') });
    await render(<FavouritesScreen />);
    expect(screen.getByText('The Hobbit')).toBeTruthy();
    expect(screen.getByText('1 item')).toBeTruthy();
    expect(screen.queryByText("Couldn't load your favourites")).toBeNull();
  });

  it.each(['grid', 'list'] as const)(
    "hands the %s cover the favourite's cover_version as its cache buster",
    async (layout) => {
      mockBooksLayout = layout;
      const older = { ...book, path: 'Tolkien/Silmarillion', title: 'The Silmarillion' };
      mockFavourites = read({ favourites: [{ ...book, cover_version: 'cv3' }, older] });
      await render(<FavouritesScreen />);
      const handed = mockCover.mock.calls.filter(([l]) => l === layout).map(([, p]) => p);
      // A favourite from an older server (no cover_version) asks without one.
      expect(handed.map((p) => p.coverVersion)).toEqual(['cv3', undefined]);
    },
  );

  it('keeps showing the favourites it has while another server is held', async () => {
    mockFavourites = read({ favourites: [book], offline: true });
    await render(<FavouritesScreen />);
    expect(screen.getByText('The Hobbit')).toBeTruthy();
    expect(screen.getByText('1 item')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });
});
