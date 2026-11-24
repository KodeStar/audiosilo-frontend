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
// The grid and its tiles have their own tests; here, which state the page is in and the
// cover version each finished tile is handed.
jest.mock('@/components/library/cover-grid', () => {
  const { Text, View } = jest.requireActual('react-native');
  return {
    CoverGrid: ({
      data,
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
    }: {
      data: readonly unknown[];
      renderItem: (item: unknown, tile: number) => ReactElement;
      ListHeaderComponent: ReactElement;
      ListEmptyComponent: ReactElement;
    }) => (
      <View>
        {ListHeaderComponent}
        {data.length === 0 ? ListEmptyComponent : <Text>{`${data.length} tiles`}</Text>}
        {data.map((item, i) => (
          <View key={i}>{renderItem(item, 120)}</View>
        ))}
      </View>
    ),
    CoverGridSkeleton: () => <Text>loading grid</Text>,
  };
});
const mockCoverTile = jest.fn((_props: { coverVersion?: string }) => null);
jest.mock('@/components/library/cover-tile', () => ({
  CoverTile: (p: { coverVersion?: string }) => mockCoverTile(p),
  useServerFlag: () => () => undefined,
}));
jest.mock('./book-items', () => ({ BookTile: () => null }));
jest.mock('@/components/home/book-title', () => ({ useProgressBook: () => undefined }));

// `unreadError`: the failure of a server with nothing kept (`error` counts a failed re-read
// of a kept list too).
type List = { isLoading: boolean; offline: boolean; error: unknown; unreadError: unknown };
let mockRecent: List & { books: MergedBook[] };
let mockProgress: List & { progress: SourcedProgress[] };
jest.mock('@/api/hooks', () => ({
  useRecentAll: () => mockRecent,
  useAllProgressAll: () => mockProgress,
}));

/* eslint-disable import/first */
import { SeeAllScreen } from './see-all-screen';
/* eslint-enable import/first */

const read: List = { isLoading: false, offline: false, error: null, unreadError: null };
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

  it('says none are finished once every progress list is read with no finished book', async () => {
    mockParams = { type: 'finished' };
    mockProgress = { ...read, progress: [place(false)] };
    await render(<SeeAllScreen />);
    expect(screen.getByText('No finished books yet.')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  // One server's progress with none finished says nothing about a held server's.
  it('says offline, never "none finished", while another server is held', async () => {
    mockParams = { type: 'finished' };
    mockProgress = { ...read, offline: true, progress: [place(false)] };
    await render(<SeeAllScreen />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByText('No finished books yet.')).toBeNull();
  });

  it("hands a finished tile its progress row's cover_version", async () => {
    mockParams = { type: 'finished' };
    mockProgress = { ...read, progress: [{ ...place(true), cover_version: 'cv5' }] };
    await render(<SeeAllScreen />);
    expect(mockCoverTile).toHaveBeenCalledWith(expect.objectContaining({ coverVersion: 'cv5' }));
  });

  it('keeps showing the finished books it has while another server is held', async () => {
    mockParams = { type: 'finished' };
    mockProgress = { ...read, offline: true, progress: [place(true)] };
    await render(<SeeAllScreen />);
    expect(screen.getByText('1 tiles')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  it('says offline for a list that failed with no network, and that it failed with one', async () => {
    const down = new Error('Network request failed');
    mockRecent = { ...read, error: down, unreadError: down, books: [] };
    mockDeviceOnline = false;
    const view = await render(<SeeAllScreen />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByText('Could not load.')).toBeNull();

    mockDeviceOnline = true;
    await view.rerender(<SeeAllScreen />);
    expect(screen.getByText('Could not load.')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  // fe#271: a kept list whose re-read failed read as "Could not load.".
  it('says there are none for a list kept with nothing in it whose re-read failed', async () => {
    mockRecent = { ...read, error: new Error('Network request failed'), books: [] };
    await render(<SeeAllScreen />);
    expect(screen.getByText('No books yet.')).toBeTruthy();
    expect(screen.queryByText('Could not load.')).toBeNull();
  });

  it('says none are finished for kept progress with none finished whose re-read failed', async () => {
    mockParams = { type: 'finished' };
    mockProgress = {
      ...read,
      error: new Error('Network request failed'),
      progress: [place(false)],
    };
    await render(<SeeAllScreen />);
    expect(screen.getByText('No finished books yet.')).toBeTruthy();
    expect(screen.queryByText('Could not load.')).toBeNull();
  });

  it('keeps showing the finished books it holds when their re-read failed', async () => {
    mockParams = { type: 'finished' };
    mockProgress = { ...read, error: new Error('Network request failed'), progress: [place(true)] };
    await render(<SeeAllScreen />);
    expect(screen.getByText('1 tiles')).toBeTruthy();
    expect(screen.queryByText('Could not load.')).toBeNull();
  });
});
