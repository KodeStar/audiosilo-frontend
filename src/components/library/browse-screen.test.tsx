import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';

let mockParams: Record<string, unknown> = {};
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/components/layout/content-scope', () => ({
  ContentScope: ({ children }: { children: ReactNode }) => children,
}));
// The route's scope ('' for a link without `?connection=`) falls back to the default.
let mockScope = 'home';
jest.mock('@/api/provider', () => ({
  useScopedCid: () => mockScope,
  useCid: (id?: string) => id ?? (mockScope || 'home'),
}));
const mockRefetch = jest.fn();
const mockBrowse = jest.fn();
let mockError: Error | null = null;
let mockData: unknown;
let mockPaused = false;
let mockDeviceOnline = true;
jest.mock('@/lib/device-online', () => ({
  ...jest.requireActual('@/lib/device-online'),
  useDeviceOnline: () => mockDeviceOnline,
}));
jest.mock('./entry-row', () => ({ EntryRow: () => null }));
jest.mock('@/api/hooks', () => ({
  useLibraries: () => ({ data: [{ id: 1, name: 'Fiction' }] }),
  useBrowseInfinite: (...a: unknown[]) => {
    mockBrowse(...a);
    return {
      data: mockData,
      isLoading: false,
      isPaused: mockPaused,
      error: mockError,
      refetch: mockRefetch,
      fetchNextPage: jest.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    };
  },
}));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';
import { useSession } from '@/stores/session';
import { setFontScale } from '@/testing/font-scale';

import { BrowseScreen } from './browse-screen';
/* eslint-enable import/first */

const connection = { id: 'home', name: 'Hearthside', serverUrl: 'https://h', token: 't' };

beforeEach(() => {
  mockParams = { libraryId: '1', path: ['Author'] };
  mockBrowse.mockClear();
  mockRefetch.mockClear();
  mockError = null;
  mockData = undefined;
  mockPaused = false;
  mockDeviceOnline = true;
  mockScope = 'home';
  useSession.setState({ connections: [connection] } as never);
});

describe('BrowseScreen', () => {
  it('wraps a long crumb inside the visible width at large text sizes', async () => {
    const folder = 'The collected stories of Ursula K. Le Guin';
    mockParams = { libraryId: '1', path: [folder, 'Volume one'] };
    mockData = { pages: [{ entries: [], total: 0 }] };
    await render(<BrowseScreen />);
    await fireEvent(screen.getByTestId('breadcrumbs'), 'layout', {
      nativeEvent: { layout: { width: 288 } },
    });
    expect(screen.getByText(folder).props.numberOfLines).toBe(1);
    expect(screen.getByTestId('breadcrumbs').props.contentContainerClassName).toBe(
      'flex-row items-center',
    );
    try {
      await setFontScale(3.1);
      expect(screen.getByText(folder).props.numberOfLines).toBeUndefined();
      expect(screen.getByRole('link', { name: folder })).toHaveStyle({ maxWidth: 288 });
      // The one-line crumbs stretch to the wrapped one's height: one contiguous strip.
      expect(screen.getByTestId('breadcrumbs').props.contentContainerClassName).toContain(
        'items-stretch',
      );
    } finally {
      await setFontScale(1);
    }
  });

  it('says the folder could not be opened, with a Retry', async () => {
    mockError = new TypeError('Network request failed');
    await render(<BrowseScreen />);
    expect(screen.getByText('Could not open this folder.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(mockRefetch).toHaveBeenCalled();
  });

  // A folder not read yet is held for the network: it showed as an empty folder.
  it('says offline, not an empty folder, while the folder waits for the network', async () => {
    mockPaused = true;
    await render(<BrowseScreen />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.getByText(/^This page shows once its server answers\./)).toBeTruthy();
    expect(screen.queryByText('This folder is empty.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says offline, with no Retry, when it failed with no network on the device', async () => {
    mockDeviceOnline = false;
    mockError = new TypeError('Network request failed');
    await render(<BrowseScreen />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByText('Could not open this folder.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  // CONNECT-02 (the 401 half): a session that ended is the sign-in state, no Retry.
  it('shows the sign-in state, and no Retry, when the session ended', async () => {
    useSession.setState({ connections: [{ ...connection, needsReconnect: 'auth' }] } as never);
    mockError = new ApiError(401, 'invalid or expired token');
    // The server answered: offline since or not, it is the sign-in state.
    mockDeviceOnline = false;
    await render(<BrowseScreen />);
    expect(screen.getByText('Sign in again to Hearthside')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(screen.queryByText('Could not open this folder.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  // Asked again and held for the network: the session has still ended.
  it('keeps the sign-in state while the folder waits for the network', async () => {
    useSession.setState({ connections: [{ ...connection, needsReconnect: 'auth' }] } as never);
    mockPaused = true;
    await render(<BrowseScreen />);
    expect(screen.getByText('Sign in again to Hearthside')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  it("shows the default server's sign-in state on a link without ?connection=", async () => {
    mockScope = '';
    useSession.setState({ connections: [{ ...connection, needsReconnect: 'auth' }] } as never);
    mockError = new ApiError(401, 'invalid or expired token');
    await render(<BrowseScreen />);
    expect(screen.getByText('Sign in again to Hearthside')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  // CONNECT-13: a folder the server answers 404 or 403 for isn't there; Retry can't help.
  it.each([404, 403])('shows not-in-library, and no Retry, for a %i', async (status) => {
    mockError = new ApiError(status, 'not found');
    await render(<BrowseScreen />);
    expect(screen.getByText("This folder isn't in the library")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  // frontend#129: `/library/abc` asks the server nothing.
  it('asks nothing for a library id that is not a number', async () => {
    mockParams = { libraryId: 'abc' };
    await render(<BrowseScreen />);
    expect(screen.getByText("This folder isn't in the library")).toBeTruthy();
    expect(mockBrowse).not.toHaveBeenCalled();
  });

  // Under large text a jump goes by row index, retried 50 ms after one that failed. A list
  // that lost the row meanwhile (a filter, a refetch) must not throw from the timer.
  it('lets go of a retried jump to a row the list no longer has', async () => {
    const entry = { name: 'Abe', path: 'Abe', is_dir: true, is_audio: false, size: 0, mod_time: 0 };
    mockData = { pages: [{ entries: [entry], total: 1 }] };
    await setFontScale(1.5);
    jest.useFakeTimers();
    try {
      await render(<BrowseScreen />);
      const list = screen.getByTestId('browse-list');
      expect(list.props.getItemLayout).toBeUndefined();
      expect(() => {
        list.props.onScrollToIndexFailed({
          index: 40,
          averageItemLength: 60,
          highestMeasuredFrameIndex: 0,
        });
        jest.advanceTimersByTime(50);
      }).not.toThrow();
    } finally {
      jest.useRealTimers();
      await setFontScale(1);
    }
  });
});
