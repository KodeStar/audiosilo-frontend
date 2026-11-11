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
let mockPaused = false;
let mockDeviceOnline = true;
jest.mock('@/lib/device-online', () => ({
  ...jest.requireActual('@/lib/device-online'),
  useDeviceOnline: () => mockDeviceOnline,
}));
jest.mock('@/api/hooks', () => ({
  useLibraries: () => ({ data: [{ id: 1, name: 'Fiction' }] }),
  useBrowseInfinite: (...a: unknown[]) => {
    mockBrowse(...a);
    return {
      data: undefined,
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

import { BrowseScreen } from './browse-screen';
/* eslint-enable import/first */

const connection = { id: 'home', name: 'Hearthside', serverUrl: 'https://h', token: 't' };

beforeEach(() => {
  mockParams = { libraryId: '1', path: ['Author'] };
  mockBrowse.mockClear();
  mockRefetch.mockClear();
  mockError = null;
  mockPaused = false;
  mockDeviceOnline = true;
  mockScope = 'home';
  useSession.setState({ connections: [connection] } as never);
});

describe('BrowseScreen', () => {
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
});
