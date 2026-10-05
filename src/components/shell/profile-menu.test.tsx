import { fireEvent, screen } from '@testing-library/react-native';

import { mountWithPortal } from '@/testing/render-overlay';

const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
}));

let mockScheme: 'light' | 'dark' = 'light';
const mockSetPref = jest.fn();
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: mockScheme, pref: mockScheme, setPref: mockSetPref }),
}));

/* eslint-disable import/first */
import { useReachability } from '@/api/reachability';
import { useSession } from '@/stores/session';

import { ProfileMenu, serverStatus } from './profile-menu';
/* eslint-enable import/first */

const user = (username: string) => ({ username }) as never;

beforeEach(() => {
  jest.clearAllMocks();
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

describe('serverStatus', () => {
  it('prefers the reconnect flag, then reachability', () => {
    expect(serverStatus({ id: 'a', needsReconnect: 'server-reset' }, { a: false })).toBe(
      'reconnect',
    );
    expect(serverStatus({ id: 'a' }, { a: false })).toBe('offline');
    expect(serverStatus({ id: 'a' }, {})).toBe('online');
  });
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
});
