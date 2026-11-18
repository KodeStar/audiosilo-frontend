import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { setAddressPick, useAddressRoute } from '@/api/address-route';
import type { User } from '@/api/types';
import { takeReconnect } from '@/components/connect/invite-handoff';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import { ReconnectBanner, reconnectConnection } from './reconnect-banner';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));
let mockNavState: unknown;
jest.mock('@/lib/root-stack', () => ({
  ...jest.requireActual('@/lib/root-stack'),
  currentNavState: () => mockNavState,
}));

const user: User = {
  id: 1,
  username: 'chris',
  role: 'user',
  disabled: false,
  has_password: true,
  has_recovery: false,
};
const HOME = 'http://192.168.1.20:8080';
const AWAY = 'https://books.example.com';

const os = Platform.OS;
beforeEach(async () => {
  resetProfilesForTests();
  await AsyncStorage.clear();
  mockPush.mockClear();
  mockNavState = undefined;
  useAddressRoute.setState({ picks: {} });
  useSession.setState({
    status: 'unauthenticated',
    connections: [],
    defaultConnectionId: null,
    pendingServerUrl: null,
    user: null,
  });
  await useSession.getState().setSession({
    serverUrl: HOME,
    serverId: 'srv-1',
    token: 'dead',
    user,
    name: 'Hearthside',
    addresses: { home: HOME, away: AWAY },
  });
  useSession.getState().markNeedsReconnect('srv-1.1', 'auth');
});
afterAll(() => {
  Platform.OS = os;
});

it('away from home, signs in again through the away address the connection uses now', async () => {
  Platform.OS = 'ios';
  setAddressPick('srv-1.1', AWAY);
  await render(<ReconnectBanner />);
  await fireEvent.press(screen.getByRole('button'));
  expect(useSession.getState().pendingServerUrl).toBe(AWAY);
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/connect/sign-in',
    params: { serverName: 'Hearthside' },
  });
  // The connection it re-pairs goes in memory, for that address only (fe#298).
  expect(takeReconnect(AWAY)).toBe('srv-1.1');
});

it('without a pick, signs in through the paired address', async () => {
  Platform.OS = 'android';
  await render(<ReconnectBanner />);
  await fireEvent.press(screen.getByText('Reconnect to Hearthside'));
  expect(useSession.getState().pendingServerUrl).toBe(HOME);
});

/** A clock the test moves (`now`), started well after any push an earlier test made: when
 * the last one was is the module's own, kept from test to test. */
let now = Date.now();
function laterClock() {
  now += 600_000;
  return jest.spyOn(Date, 'now').mockImplementation(() => now);
}

it('a double tap pushes one sign-in step (one on its way, then one on screen)', async () => {
  const conn = useSession.getState().connections[0];
  const app = { index: 0, routes: [{ name: '(app)' }] };
  const clock = laterClock();
  mockNavState = app;
  // The second tap lands before the first has written the address.
  await act(() => Promise.all([reconnectConnection(conn), reconnectConnection(conn)]));
  expect(mockPush).toHaveBeenCalledTimes(1);
  // The step is pushed and not on the stack yet (the router applies a push a render later,
  // and the address is written at once, so nothing is on its way either): the second tap
  // of a double tap reads the app's stack, and pushes nothing.
  await render(<ReconnectBanner />);
  now += 150;
  await fireEvent.press(screen.getByRole('button'));
  expect(mockPush).toHaveBeenCalledTimes(1);
  // Its sign-in step is on screen now: a tap that still reaches the banner pushes nothing,
  // however long after.
  mockNavState = {
    index: 1,
    routes: [
      { name: '(app)' },
      { name: 'connect', state: { index: 0, routes: [{ name: 'sign-in' }] } },
    ],
  };
  now += 60_000;
  await fireEvent.press(screen.getByRole('button'));
  expect(mockPush).toHaveBeenCalledTimes(1);
  // Back on the app, a tap starts it again.
  mockNavState = app;
  await fireEvent.press(screen.getByRole('button'));
  expect(mockPush).toHaveBeenCalledTimes(2);
  clock.mockRestore();
});

it('a push that never reached the stack holds Reconnect back only for a moment', async () => {
  const conn = useSession.getState().connections[0];
  const clock = laterClock();
  mockNavState = { index: 0, routes: [{ name: '(app)' }] };
  await act(() => reconnectConnection(conn));
  expect(mockPush).toHaveBeenCalledTimes(1);
  now += 999;
  await act(() => reconnectConnection(conn));
  expect(mockPush).toHaveBeenCalledTimes(1);
  now += 1;
  await act(() => reconnectConnection(conn));
  expect(mockPush).toHaveBeenCalledTimes(2);
  clock.mockRestore();
});

it('renders nothing when no connection needs reconnecting', async () => {
  useSession.getState().clearNeedsReconnect('srv-1.1');
  await render(<ReconnectBanner />);
  expect(screen.queryByRole('button')).toBeNull();
});

describe('ReconnectBanner and the people on this device (Phase 8)', () => {
  it("asks only about the person listening's servers", async () => {
    const id = useSession.getState().connections[0].id;
    useSession.getState().markNeedsReconnect(id, 'auth');
    useProfiles.setState({
      hydrated: true,
      profiles: [
        { id: 'chris', name: 'Chris', connectionIds: ['other.1'] },
        { id: 'sam', name: 'Sam', connectionIds: [id] },
      ],
      activeProfileId: 'chris',
    });
    const view = await render(<ReconnectBanner />);
    expect(view.toJSON()).toBeNull();
  });
});
