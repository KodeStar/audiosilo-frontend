import { fireEvent, screen } from '@testing-library/react-native';

import { mountWithPortal } from '@/testing/render-overlay';

const mockRouter = { push: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
}));

let mockScheme: 'light' | 'dark' = 'light';
const mockSetPref = jest.fn();
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({
    scheme: mockScheme,
    pref: mockScheme,
    setPref: mockSetPref,
    // The provider's toggle, over the mocked setPref.
    toggleScheme: () => mockSetPref(mockScheme === 'dark' ? 'light' : 'dark'),
  }),
}));

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

let mockServed: string | null = null;
jest.mock('@/lib/base-url', () => ({
  ...jest.requireActual('@/lib/base-url'),
  servedOrigin: () => mockServed,
}));

/* eslint-disable import/first */
import { useReachability } from '@/api/reachability';
import { setSecure } from '@/lib/secure-store';
import { pinKey } from '@/lib/profile-pin';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import { ProfileMenu } from './profile-menu';
/* eslint-enable import/first */

const user = (username: string) => ({ username }) as never;

beforeEach(() => {
  mockServed = null;
  jest.clearAllMocks();
  resetProfilesForTests();
  mockScheme = 'light';
  useSession.setState({
    connections: [
      { id: 'c1', name: 'Hearthside', serverUrl: 'u', token: 't', user: user('chris') },
      { id: 'c2', name: "Maya's Shelf", serverUrl: 'v', token: 't', user: user('chris.m') },
      {
        id: 'c3',
        name: 'Old box',
        serverUrl: 'w',
        token: 't',
        user: user('chris'),
        needsReconnect: 'auth',
      },
    ],
    defaultConnectionId: 'c1',
    user: user('chris'),
  });
  useReachability.setState({ online: { c1: true, c2: false, c3: false } });
});

describe('ProfileMenu', () => {
  async function open() {
    await mountWithPortal(<ProfileMenu showName />);
    await fireEvent.press(screen.getByLabelText('Servers and account, chris'));
  }

  it('lists every server with its state, then add, account and appearance', async () => {
    await open();
    expect(screen.getByText('Servers')).toBeTruthy();
    expect(screen.getByText('Hearthside')).toBeTruthy();
    expect(screen.getByText('Signed in as chris')).toBeTruthy();
    expect(screen.getByText("Maya's Shelf")).toBeTruthy();
    expect(screen.getByText('Offline')).toBeTruthy();
    expect(screen.getByText('Needs signing in again')).toBeTruthy();
    expect(screen.getByText('Add a server')).toBeTruthy();
    expect(screen.getByText('Account on Hearthside')).toBeTruthy();
    expect(screen.getByText('Dark appearance')).toBeTruthy();
  });

  it("opens the You hub's Journal", async () => {
    await open();
    await fireEvent.press(screen.getByText('Journal'));
    expect(mockRouter.navigate).toHaveBeenCalledWith({
      pathname: '/you',
      params: { section: 'journal' },
    });
  });

  it('opens Settings on the current tab', async () => {
    await open();
    await fireEvent.press(screen.getByText('Settings'));
    expect(mockRouter.push).toHaveBeenCalledWith('/settings');
  });

  it('opens the Household page on the current tab (8b-1)', async () => {
    await open();
    await fireEvent.press(screen.getByText('Household'));
    expect(mockRouter.push).toHaveBeenCalledWith('/household');
  });

  it("opens a server's account screen", async () => {
    await open();
    await fireEvent.press(screen.getByText("Maya's Shelf"));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/account',
      params: { connection: 'c2' },
    });
  });

  it('adds a server through the existing connect flow', async () => {
    await open();
    await fireEvent.press(screen.getByText('Add a server'));
    expect(mockRouter.push).toHaveBeenCalledWith('/connect?add=1');
  });

  it('offers no other server on the player the server serves', async () => {
    mockServed = 'https://books.example';
    useSession.setState((s) => ({
      connections: s.connections.map((c) => ({ ...c, serverUrl: 'https://books.example' })),
    }));
    await open();
    expect(screen.getByText('Hearthside')).toBeTruthy();
    expect(screen.queryByText('Add a server')).toBeNull();
  });

  it('still adds servers on a web build hosted beside its servers', async () => {
    mockServed = 'https://player.example';
    useSession.setState((s) => ({
      connections: s.connections.map((c) => ({ ...c, serverUrl: 'https://books.example' })),
    }));
    await open();
    expect(screen.getByText('Add a server')).toBeTruthy();
  });

  it('opens the account on the default server', async () => {
    await open();
    await fireEvent.press(screen.getByText('Account on Hearthside'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/account',
      params: { connection: 'c1' },
    });
  });

  it('flips the appearance to the other scheme', async () => {
    mockScheme = 'dark';
    await open();
    await fireEvent.press(screen.getByText('Light appearance'));
    expect(mockSetPref).toHaveBeenCalledWith('light');
  });

  it('renders nothing when signed out', async () => {
    useSession.setState({ user: null, defaultConnectionId: null });
    await mountWithPortal(<ProfileMenu showName />);
    expect(screen.queryByTestId('top-bar-profile')).toBeNull();
  });

  describe('with two people on this device', () => {
    beforeEach(() => {
      useProfiles.setState({
        hydrated: true,
        profiles: [
          { id: 'chris', name: 'Chris', connectionIds: ['c1', 'c3'] },
          { id: 'sam', name: 'Sam', connectionIds: ['c2'], hasPin: true },
        ],
        activeProfileId: 'chris',
      });
    });

    async function openAs(name: string) {
      await mountWithPortal(<ProfileMenu showName />);
      await fireEvent.press(screen.getByLabelText(`Servers and account, ${name}`));
    }

    it("lists who is listening, the other people, and only the listener's servers", async () => {
      await openAs('Chris');
      expect(screen.getByText('Listening as')).toBeTruthy();
      expect(screen.getAllByText('Chris').length).toBeGreaterThan(0);
      expect(screen.getByLabelText('Switch to Sam')).toBeTruthy();
      expect(screen.getByText('Hearthside')).toBeTruthy();
      expect(screen.getByText('Old box')).toBeTruthy();
      // Sam's server is Sam's: not in Chris's menu.
      expect(screen.queryByText("Maya's Shelf")).toBeNull();
    });

    it("asks for Sam's PIN before switching to him", async () => {
      await setSecure(
        pinKey('sam'),
        JSON.stringify({ v: 1, salt: '0'.repeat(32), iterations: 1, hash: '0'.repeat(64) }),
      );
      await openAs('Chris');
      await fireEvent.press(screen.getByLabelText('Switch to Sam'));
      expect(await screen.findByText("Enter Sam's PIN")).toBeTruthy();
      expect(useProfiles.getState().activeProfileId).toBe('chris');
    });

    it('opens "Who\'s listening?"', async () => {
      await openAs('Chris');
      await fireEvent.press(screen.getByText("Who's listening?"));
      expect(mockRouter.push).toHaveBeenCalledWith('/profiles');
    });
  });
});
