import { fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { Collection, CollectionDetail } from '@/api/types';

let mockParams: Record<string, string | undefined> = {};
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => false },
  useLocalSearchParams: () => mockParams,
  useGlobalSearchParams: () => mockParams,
}));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/lib/open', () => ({ useOpen: () => ({ openCollection: jest.fn() }) }));
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'desktop',
}));
jest.mock('@/lib/use-page-title', () => ({ usePageTitle: () => undefined }));
jest.mock('@/api/provider', () => ({ useCid: () => 'home' }));
jest.mock('@/components/layout/content-scope', () => ({
  ContentScope: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/downloads/store', () => ({
  useDownloads: (select: (s: object) => unknown) => select({ supported: true }),
}));
let mockDeviceOnline = true;
jest.mock('@/lib/device-online', () => ({
  ...jest.requireActual('@/lib/device-online'),
  useDeviceOnline: () => mockDeviceOnline,
}));
// The cards and dialogs have their own tests; here, only which state the list is in.
jest.mock('../collections/collection-card', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    CollectionCard: ({ collection }: { collection: Collection }) => <Text>{collection.name}</Text>,
    CollectionCardFrame: ({ title, lines }: { title: string; lines: string[] }) => (
      <>
        <Text>{title}</Text>
        {lines.filter(Boolean).map((line) => (
          <Text key={line}>{line}</Text>
        ))}
      </>
    ),
    CollectionCardSkeleton: () => <Text>loading card</Text>,
    CoverFan: () => null,
    NewCollectionCard: () => <Text>New collection</Text>,
    useShareText: () => '',
  };
});
jest.mock('../books/book-items', () => ({
  BookTile: () => null,
  BookListRow: () => null,
  BookListHeader: () => null,
}));
jest.mock('../books/books-controls', () => ({ LayoutToggle: () => null }));
jest.mock('../cover-tile', () => ({ CoverTile: () => null }));
jest.mock('../collections/collection-dialogs', () => ({
  collectionFailed: jest.fn(),
  CollectionFormDialog: () => null,
  ShareCollectionDialog: () => null,
}));

type Read<T> = {
  data?: T;
  isLoading: boolean;
  isPaused: boolean;
  error: unknown;
  refetch: jest.Mock;
};
const unread = <T,>(state: Partial<Read<T>> = {}): Read<T> => ({
  isLoading: false,
  isPaused: false,
  error: null,
  refetch: jest.fn(),
  ...state,
});
let mockCollections: Read<Collection[]>;
let mockCollection: Read<CollectionDetail>;
let mockSupported: boolean | undefined = true;
let mockFavourites: { favourites: object[]; offline?: boolean; error?: unknown } = {
  favourites: [],
};
jest.mock('@/api/hooks', () => ({
  useCapability: () => mockSupported,
  useCollections: () => mockCollections,
  useCollection: () => mockCollection,
  useFavouritesAll: () => mockFavourites,
  useAddCollectionItem: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDeleteCollection: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useProgressLookup: () => ({ progressOf: () => undefined }),
  useRemoveCollectionItem: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

/* eslint-disable import/first */
import { CollectionScreen } from '../collection-screen';
import { CollectionsMode } from './collections-mode';
/* eslint-enable import/first */

const OFFLINE = "You're offline";
const down = () => new TypeError('Network request failed');

beforeEach(() => {
  mockDeviceOnline = true;
  mockSupported = true;
  mockFavourites = { favourites: [] };
  mockParams = { connection: 'home', id: '4' };
  mockCollections = unread();
  mockCollection = unread();
});

/** The mode lays its cards out once it knows its width. */
async function mountMode() {
  await render(<CollectionsMode connectionId="home" libraryId={1} />);
  await fireEvent(screen.getByTestId('collections-mode'), 'layout', {
    nativeEvent: { layout: { width: 900, height: 600 } },
  });
}

// The list is held for the network: where the mode used to fail with a Retry it showed
// Favourites alone, as if the listener had no collections and could make none.
describe('CollectionsMode with no list read', () => {
  it('says offline, with no Retry, while the list waits for the network', async () => {
    mockCollections = unread({ isPaused: true });
    await mountMode();
    expect(screen.getByText(OFFLINE)).toBeTruthy();
    expect(
      screen.getByText(
        "This list shows once its server answers. Books you've downloaded are in Downloads.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    // Favourites is every server's, as last read: it stays.
    expect(screen.getByText('Favourites')).toBeTruthy();
    expect(screen.queryByText('New collection')).toBeNull();
  });

  // fe#271: the Favourites card said "0 items" over a list it had not read.
  it('says no count on the Favourites card while its list is held or failed', async () => {
    mockCollections = { ...unread(), data: [] };
    await mountMode();
    expect(screen.getByText('0 items')).toBeTruthy();
    for (const held of [{ offline: true }, { error: new Error('down') }]) {
      mockFavourites = { favourites: [], ...held };
      await mountMode();
      expect(screen.getByText('Favourites')).toBeTruthy();
      expect(screen.queryByText('0 items')).toBeNull();
    }
  });

  it('says offline, with no Retry, when it failed with no network on the device', async () => {
    mockDeviceOnline = false;
    mockCollections = unread({ error: down() });
    await mountMode();
    expect(screen.getByText(OFFLINE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('keeps the error with a Retry when it failed with a network on the device', async () => {
    mockCollections = unread({ error: down() });
    await mountMode();
    expect(screen.queryByText(OFFLINE)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(mockCollections.refetch).toHaveBeenCalled();
  });

  it('keeps showing the collections it holds while it is offline', async () => {
    mockDeviceOnline = false;
    mockCollections = unread({
      data: [{ id: 4, name: 'Road trip' } as Collection],
      isPaused: true,
      error: down(),
    });
    await mountMode();
    expect(screen.queryByText(OFFLINE)).toBeNull();
    expect(screen.getByText('Road trip')).toBeTruthy();
    expect(screen.getByText('New collection')).toBeTruthy();
  });
});

// The read is held for the network (it stays pending): the skeleton never ended.
describe('CollectionScreen with the collection not read', () => {
  it('says offline, with no Retry, while it waits for the network', async () => {
    mockCollection = unread({ isPaused: true });
    await render(<CollectionScreen />);
    expect(screen.getByText(OFFLINE)).toBeTruthy();
    expect(
      screen.getByText(
        "This page shows once its server answers. Books you've downloaded are in Downloads.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says offline, with no Retry, when it failed with no network on the device', async () => {
    mockDeviceOnline = false;
    mockCollection = unread({ error: down() });
    await render(<CollectionScreen />);
    expect(screen.getByText(OFFLINE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('keeps the error with a Retry when it failed with a network on the device', async () => {
    mockCollection = unread({ error: down() });
    await render(<CollectionScreen />);
    expect(screen.queryByText(OFFLINE)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(mockCollection.refetch).toHaveBeenCalled();
  });

  // fe#270: while the flag is unknown the read takes a failed `/server` read's error, whose
  // 404 says nothing of this collection.
  it("reads a 404 as gone only once the server's flag is known", async () => {
    mockSupported = undefined;
    mockCollection = unread({ error: new ApiError(404, 'not found') });
    await render(<CollectionScreen />);
    expect(screen.queryByText("This collection isn't here")).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
