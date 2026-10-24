import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => ({ libraryId: '1', path: ['Author'] }),
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
let mockError: Error | null = null;
jest.mock('@/api/hooks', () => ({
  useLibraries: () => ({ data: [{ id: 1, name: 'Fiction' }] }),
  useBrowseInfinite: () => ({
    data: undefined,
    isLoading: false,
    error: mockError,
    refetch: mockRefetch,
    fetchNextPage: jest.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
}));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';
import { useSession } from '@/stores/session';

import { BrowseScreen } from './browse-screen';
/* eslint-enable import/first */

const connection = { id: 'home', name: 'Hearthside', serverUrl: 'https://h', token: 't' };

beforeEach(() => {
  mockRefetch.mockClear();
  mockError = null;
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

  // CONNECT-02 (the 401 half): a session that ended is the sign-in state, no Retry.
  it('shows the sign-in state, and no Retry, when the session ended', async () => {
    useSession.setState({ connections: [{ ...connection, needsReconnect: 'auth' }] } as never);
    mockError = new ApiError(401, 'invalid or expired token');
    await render(<BrowseScreen />);
    expect(screen.getByText('Sign in again to Hearthside')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(screen.queryByText('Could not open this folder.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it("shows the default server's sign-in state on a link without ?connection=", async () => {
    mockScope = '';
    useSession.setState({ connections: [{ ...connection, needsReconnect: 'auth' }] } as never);
    mockError = new ApiError(401, 'invalid or expired token');
    await render(<BrowseScreen />);
    expect(screen.getByText('Sign in again to Hearthside')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
