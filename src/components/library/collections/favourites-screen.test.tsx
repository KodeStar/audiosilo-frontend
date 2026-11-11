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
// The grid and its tiles have their own tests; here, only which state the page is in.
jest.mock('@/components/library/cover-grid', () => {
  const { Text, View } = jest.requireActual('react-native');
  return {
    CoverGrid: ({
      data,
      ListHeaderComponent,
      ListEmptyComponent,
    }: {
      data: readonly SourcedFavourite[];
      ListHeaderComponent: ReactElement;
      ListEmptyComponent: ReactElement | null;
    }) => (
      <View>
        {ListHeaderComponent}
        {data.length === 0
          ? ListEmptyComponent
          : data.map((f) => <Text key={f.path}>{f.title}</Text>)}
      </View>
    ),
    CoverGridSkeleton: () => <Text>loading grid</Text>,
    CoverListRow: () => null,
  };
});
jest.mock('@/components/library/cover-tile', () => ({
  CoverTile: () => null,
  useServerFlag: () => () => undefined,
}));
jest.mock('@/components/library/books/books-controls', () => ({ LayoutToggle: () => null }));
jest.mock('@/components/library/books/books-layout-store', () => ({
  useBooksLayout: () => ['grid', jest.fn()],
}));

type Favourites = {
  favourites: SourcedFavourite[];
  isLoading: boolean;
  offline: boolean;
  error: unknown;
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
  ...state,
});

beforeEach(() => {
  mockDeviceOnline = true;
  mockFavourites = read();
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
    mockFavourites = read({ error: new Error('Network request failed') });
    mockDeviceOnline = false;
    const view = await render(<FavouritesScreen />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByText("Couldn't load your favourites")).toBeNull();

    mockDeviceOnline = true;
    await view.rerender(<FavouritesScreen />);
    expect(screen.getByText("Couldn't load your favourites")).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  it('keeps showing the favourites it has while another server is held', async () => {
    mockFavourites = read({ favourites: [book], offline: true });
    await render(<FavouritesScreen />);
    expect(screen.getByText('The Hobbit')).toBeTruthy();
    expect(screen.getByText('1 item')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });
});
