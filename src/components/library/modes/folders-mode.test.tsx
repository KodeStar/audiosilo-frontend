import { fireEvent, render, screen } from '@testing-library/react-native';

import type { LibrariesOfServer } from '@/api/hooks';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
}));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
const mockOpenLibrary = jest.fn();
jest.mock('@/lib/open', () => ({ useOpen: () => ({ openLibrary: mockOpenLibrary }) }));
const mockRetry = jest.fn();
let mockLists: LibrariesOfServer[] = [];
jest.mock('@/api/hooks', () => ({
  useFavouritesAll: () => ({ favourites: [] }),
  useLibrariesAll: () => ({
    groups: mockLists,
    libraries: mockLists.flatMap((g) => g.libraries),
    isLoading: false,
    retryServer: mockRetry,
  }),
}));
let mockSignedOut: { id: string; name: string; needsReconnect: string }[] = [];
jest.mock('@/components/layout/sign-in-again', () => ({
  ...jest.requireActual('@/components/layout/sign-in-again'),
  useSignedOutConnections: () => mockSignedOut,
}));

/* eslint-disable import/first */
import { FoldersMode } from './folders-mode';
/* eslint-enable import/first */

const list = (
  connectionId: string,
  connectionName: string,
  status: LibrariesOfServer['status'],
  names: string[] = [],
): LibrariesOfServer => ({
  connectionId,
  connectionName,
  status,
  libraries: names.map((name, i) => ({
    id: i + 1,
    name,
    default_view: 'folders',
    connectionId,
    connectionName,
  })) as unknown as LibrariesOfServer['libraries'],
});

beforeEach(() => {
  mockRetry.mockClear();
  mockSignedOut = [];
  mockLists = [];
});

describe('FoldersMode', () => {
  // CONNECT-06: one server down names it under its heading, with a Retry.
  it('names the server whose libraries failed, under its heading, with a Retry', async () => {
    mockLists = [list('a', 'Home', 'ready', ['Audiobooks']), list('b', "Maya's Shelf", 'error')];
    await render(<FoldersMode />);
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.getByText("Maya's Shelf")).toBeTruthy();
    expect(screen.getByText("Couldn't load libraries from Maya's Shelf.")).toBeTruthy();
    expect(screen.getByText('Audiobooks')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    // Only that server is asked again.
    expect(mockRetry).toHaveBeenCalledWith('b');
  });

  it('names the one server too when it is the only one', async () => {
    mockLists = [list('a', 'Home', 'error')];
    await render(<FoldersMode />);
    expect(screen.getByText("Couldn't load libraries from Home.")).toBeTruthy();
    expect(screen.queryByText('No libraries are shared with your account yet.')).toBeNull();
  });

  it('shows the sign-in state, not a load error, for a server whose sign-in ended', async () => {
    mockSignedOut = [{ id: 'b', name: "Maya's Shelf", needsReconnect: 'auth' }];
    mockLists = [list('a', 'Home', 'ready', ['Audiobooks']), list('b', "Maya's Shelf", 'error')];
    await render(<FoldersMode />);
    expect(screen.getByText("Sign in again to Maya's Shelf")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load libraries/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    // Only one server is signed in: no server headings.
    expect(screen.queryByText('Home')).toBeNull();
  });

  it("keeps the server headings while a signed-out server's list is still cached", async () => {
    mockSignedOut = [{ id: 'b', name: "Maya's Shelf", needsReconnect: 'auth' }];
    mockLists = [
      list('a', 'Home', 'ready', ['Audiobooks']),
      list('b', "Maya's Shelf", 'ready', ['Kids']),
    ];
    await render(<FoldersMode />);
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.getByText("Maya's Shelf")).toBeTruthy();
    expect(screen.getByText('Kids')).toBeTruthy();
  });

  it('opens a library from its row', async () => {
    mockLists = [list('a', 'Home', 'ready', ['Audiobooks'])];
    await render(<FoldersMode />);
    await fireEvent.press(screen.getByRole('button', { name: /Audiobooks/ }));
    expect(mockOpenLibrary).toHaveBeenCalledWith('a', 1);
  });
});
