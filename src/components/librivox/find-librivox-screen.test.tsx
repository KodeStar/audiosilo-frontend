import { act, fireEvent, screen } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { ServerInfo } from '@/api/types';
import { ADMIN } from '@/testing/bridge-fixtures';
import { librivoxServer } from '@/testing/librivox-fixtures';
import { mountWithPortal } from '@/testing/render-overlay';

let mockParams: Record<string, string | undefined> = {};
jest.mock('@/lib/route-params', () => ({ useRouteParams: () => mockParams }));
jest.mock('@/components/layout/content-scope', () => ({
  ContentScope: ({ children }: { children: React.ReactNode }) => children,
}));
// The page's connection: the route's scope, else the default one (a link without it).
let mockCid = 'c1';
jest.mock('@/api/provider', () => ({ useCid: () => mockCid }));
const mockTitles: (string | undefined)[] = [];
jest.mock('@/lib/use-page-title', () => ({
  usePageTitle: (t: string | undefined) => mockTitles.push(t),
}));
let mockServer: ServerInfo | undefined;
let mockHeld = false;
let mockInfoError: unknown = null;
const mockInfoRefetch = jest.fn();
jest.mock('@/api/hooks', () => ({
  useServerInfo: () => ({
    data: mockServer,
    isPaused: mockHeld,
    error: mockInfoError,
    isError: !!mockInfoError,
    refetch: mockInfoRefetch,
  }),
}));
// The search has its own suite: here, whether the page shows it and for which library.
jest.mock('./librivox-search', () => ({
  LibrivoxSearch: ({
    header,
    libraryId,
    connectionId,
    bridgeAway,
  }: {
    header: React.ReactNode;
    libraryId: number;
    connectionId: string;
    bridgeAway?: boolean;
  }) => {
    const { Text, View } = jest.requireActual('react-native');
    return (
      <View>
        {header}
        <Text testID="librivox-search">{`${connectionId} ${libraryId}`}</Text>
        {bridgeAway ? <Text testID="librivox-search-away">away</Text> : null}
      </View>
    );
  },
}));

/* eslint-disable import/first */
import { BRIDGE_IDLE_POLL_MS } from '@/lib/bridge-jobs';
import { useSession } from '@/stores/session';
import { driveAppState } from '@/testing/app-state';

import { FindLibrivoxScreen } from './find-librivox-screen';
/* eslint-enable import/first */

const app = driveAppState();

const signIn = (user: object = ADMIN, id = 'c1') =>
  useSession.setState({
    connections: [{ id, name: 'Home', serverUrl: 'u', token: 't', user } as never],
  });

beforeEach(() => {
  mockParams = { connection: 'c1', library: '3' };
  mockCid = 'c1';
  mockServer = librivoxServer();
  mockHeld = false;
  mockInfoError = null;
  mockInfoRefetch.mockReset();
  mockTitles.length = 0;
  signIn();
});

describe('FindLibrivoxScreen', () => {
  it('shows the search for an admin whose Bridge runs librivox, and names the tab', async () => {
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.getByText('Find on LibriVox')).toBeTruthy();
    expect(screen.getByTestId('librivox-search').props.children).toBe('c1 3');
    expect(mockTitles).toContain('Find on LibriVox');
  });

  it('waits for the server answer before deciding', async () => {
    mockServer = undefined;
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.getByTestId('find-librivox-loading')).toBeTruthy();
    expect(screen.queryByTestId('librivox-search')).toBeNull();
  });

  it('says it is offline, not a skeleton, while the server answer waits for the network', async () => {
    mockServer = undefined;
    mockHeld = true;
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByTestId('find-librivox-loading')).toBeNull();
  });

  it('tells anyone but an admin that only an admin can add, and asks nothing', async () => {
    signIn({ ...ADMIN, role: 'user' });
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.getByText('Only an admin can add books from LibriVox.')).toBeTruthy();
    expect(screen.queryByTestId('librivox-search')).toBeNull();
  });

  it('tells a demo account the same', async () => {
    signIn({ ...ADMIN, is_demo: true });
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.getByText('Only an admin can add books from LibriVox.')).toBeTruthy();
  });

  it('says the Bridge must be online and up to date on an older server or Bridge', async () => {
    mockServer = librivoxServer({ bridge: { version: '0.6.0', features: ['sidecars'] } });
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(
      screen.getByText('Adding from LibriVox needs the Bridge online and up to date.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('librivox-search')).toBeNull();
  });

  it('says community metadata is off', async () => {
    const caps = librivoxServer().capabilities;
    mockServer = librivoxServer({ capabilities: { ...caps, metadata: false } });
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.getByText('Community metadata is off')).toBeTruthy();
    expect(screen.queryByTestId('librivox-search')).toBeNull();
  });

  it("opens for the default connection's admin from a link without ?connection= (fe#293)", async () => {
    mockParams = { library: '3' };
    mockCid = 'c2';
    signIn(ADMIN, 'c2');
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.queryByText('Only an admin can add books from LibriVox.')).toBeNull();
    expect(screen.getByTestId('librivox-search').props.children).toBe('c2 3');
  });

  it('says a failed server read with nothing kept failed, with Retry, not a skeleton', async () => {
    mockServer = undefined;
    mockInfoError = new ApiError(500, 'boom');
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.queryByTestId('find-librivox-loading')).toBeNull();
    expect(
      screen.getByText("Couldn't reach the server just now. Try again in a moment."),
    ).toBeTruthy();
    await fireEvent.press(screen.getByText('Retry'));
    expect(mockInfoRefetch).toHaveBeenCalled();
  });

  describe('a Bridge that goes away while the page is open', () => {
    const away = () => librivoxServer({ bridge: { version: '0.7.0', features: [] } });

    // A new `/server` answer, read again: the session's change re-renders the page.
    const readAgain = (user: object = ADMIN) => act(async () => signIn({ ...user }));

    it('keeps the page and its search, says so, and holds Add back', async () => {
      await mountWithPortal(<FindLibrivoxScreen />);
      expect(screen.queryByTestId('librivox-search-away')).toBeNull();
      mockServer = away();
      await readAgain();
      expect(screen.getByTestId('librivox-search')).toBeTruthy();
      expect(screen.getByTestId('librivox-search-away')).toBeTruthy();
      expect(
        screen.getByText(
          "The Bridge isn't online right now. You can keep searching, and add once it's back.",
        ),
      ).toBeTruthy();
      mockServer = librivoxServer();
      await readAgain();
      expect(screen.queryByTestId('librivox-search-away')).toBeNull();
    });

    it('asks /server again while it is away, so Add comes back with the Bridge', async () => {
      await mountWithPortal(<FindLibrivoxScreen />);
      jest.useFakeTimers();
      try {
        await act(async () => jest.advanceTimersByTime(BRIDGE_IDLE_POLL_MS));
        // Not while the Bridge is online: nothing to wait for.
        expect(mockInfoRefetch).not.toHaveBeenCalled();
        mockServer = away();
        await readAgain();
        await act(async () => jest.advanceTimersByTime(BRIDGE_IDLE_POLL_MS));
        expect(mockInfoRefetch).toHaveBeenCalledTimes(1);
        // Never from the background.
        app.becomes('background');
        await act(async () => jest.advanceTimersByTime(BRIDGE_IDLE_POLL_MS));
        expect(mockInfoRefetch).toHaveBeenCalledTimes(1);
        app.becomes('active');
        mockServer = librivoxServer();
        await readAgain();
        await act(async () => jest.advanceTimersByTime(BRIDGE_IDLE_POLL_MS));
        expect(mockInfoRefetch).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('still closes when the page was never open (it says why)', async () => {
      mockServer = away();
      await mountWithPortal(<FindLibrivoxScreen />);
      expect(screen.queryByTestId('librivox-search')).toBeNull();
      expect(screen.getByTestId('find-librivox-closed')).toBeTruthy();
    });

    it('still closes for metadata turned off, or anyone no longer an admin', async () => {
      await mountWithPortal(<FindLibrivoxScreen />);
      const caps = librivoxServer().capabilities;
      mockServer = librivoxServer({ capabilities: { ...caps, metadata: false } });
      await readAgain();
      expect(screen.queryByTestId('librivox-search')).toBeNull();
      mockServer = away();
      await readAgain({ ...ADMIN, role: 'user' });
      expect(screen.getByText('Only an admin can add books from LibriVox.')).toBeTruthy();
    });
  });

  it('says a link without a library points to nothing', async () => {
    mockParams = { connection: 'c1' };
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.getByText("This link doesn't point to anything here.")).toBeTruthy();
  });
});
