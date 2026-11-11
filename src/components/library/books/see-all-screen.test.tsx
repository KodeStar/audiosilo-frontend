import { render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import type { MergedBook, SourcedProgress } from '@/api/hooks';

let mockParams: { type?: string } = {};
jest.mock('expo-router', () => ({ router: { setParams: jest.fn() } }));
jest.mock('@/lib/route-params', () => ({ useRouteParams: () => mockParams }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/lib/use-page-title', () => ({ usePageTitle: () => undefined }));
jest.mock('@/lib/use-now', () => ({ useMinuteClock: () => Date.now() }));
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
      data: readonly unknown[];
      ListHeaderComponent: ReactElement;
      ListEmptyComponent: ReactElement;
    }) => (
      <View>
        {ListHeaderComponent}
        {data.length === 0 ? ListEmptyComponent : <Text>{`${data.length} tiles`}</Text>}
      </View>
    ),
    CoverGridSkeleton: () => <Text>loading grid</Text>,
  };
});
jest.mock('@/components/library/cover-tile', () => ({
  CoverTile: () => null,
  useServerFlag: () => () => undefined,
}));
jest.mock('./book-items', () => ({ BookTile: () => null }));
jest.mock('@/components/home/book-title', () => ({ useProgressBook: () => undefined }));

type List = { isLoading: boolean; offline: boolean; error: unknown };
let mockRecent: List & { books: MergedBook[] };
let mockProgress: List & { progress: SourcedProgress[] };
jest.mock('@/api/hooks', () => ({
  useRecentAll: () => mockRecent,
  useAllProgressAll: () => mockProgress,
}));

/* eslint-disable import/first */
import { SeeAllScreen } from './see-all-screen';
/* eslint-enable import/first */

const read: List = { isLoading: false, offline: false, error: null };
const place = (finished: boolean) =>
  ({
    connectionId: 'home',
    library_id: 1,
    path: finished ? 'Tolkien/The Hobbit' : 'Tolkien/The Silmarillion',
    finished,
    updated_at: '2026-10-01T10:00:00Z',
  }) as SourcedProgress;

beforeEach(() => {
  mockParams = {};
  mockDeviceOnline = true;
  mockRecent = { ...read, books: [] };
  mockProgress = { ...read, progress: [] };
});

describe('SeeAllScreen', () => {
  it('says there are no books once every list is read with nothing in it', async () => {
    await render(<SeeAllScreen />);
    expect(screen.getByText('No books yet.')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  // A held list is not loading (`isLoading` is false): it used to read as "No books yet".
  it('says offline, never "no books", while a list waits for the network', async () => {
    mockRecent = { ...read, offline: true, books: [] };
    await render(<SeeAllScreen />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.getByText(/This list shows once its server answers\./)).toBeTruthy();
    expect(screen.queryByText('No books yet.')).toBeNull();
  });

  it('says offline for Recently finished while the progress list is held', async () => {
    mockParams = { type: 'finished' };
    mockProgress = { ...read, offline: true, progress: [] };
    await render(<SeeAllScreen />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByText('No finished books yet.')).toBeNull();
  });

  it('says none are finished when the progress it has holds no finished book', async () => {
    mockParams = { type: 'finished' };
    // Another server's list is held: the one that answered still says what it knows.
    mockProgress = { ...read, offline: true, progress: [place(false)] };
    await render(<SeeAllScreen />);
    expect(screen.getByText('No finished books yet.')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  it('says offline for a list that failed with no network, and that it failed with one', async () => {
    mockRecent = { ...read, error: new Error('Network request failed'), books: [] };
    mockDeviceOnline = false;
    const view = await render(<SeeAllScreen />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByText('Could not load.')).toBeNull();

    mockDeviceOnline = true;
    await view.rerender(<SeeAllScreen />);
    expect(screen.getByText('Could not load.')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });
});
