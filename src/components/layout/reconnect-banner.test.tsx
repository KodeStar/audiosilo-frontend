import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { setAddressPick, useAddressRoute } from '@/api/address-route';
import type { User } from '@/api/types';
import { useSession } from '@/stores/session';

import { ReconnectBanner } from './reconnect-banner';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));

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
  await AsyncStorage.clear();
  mockPush.mockClear();
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
  useSession.getState().markNeedsReconnect('srv-1', 'auth');
});
afterAll(() => {
  Platform.OS = os;
});

it('away from home, signs in again through the away address the connection uses now', async () => {
  Platform.OS = 'ios';
  setAddressPick('srv-1', AWAY);
  await render(<ReconnectBanner />);
  await fireEvent.press(screen.getByRole('button'));
  expect(useSession.getState().pendingServerUrl).toBe(AWAY);
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/connect/sign-in',
    params: { serverName: 'Hearthside', reconnect: 'srv-1' },
  });
});

it('without a pick, signs in through the paired address', async () => {
  Platform.OS = 'android';
  await render(<ReconnectBanner />);
  await fireEvent.press(screen.getByText('Reconnect to Hearthside'));
  expect(useSession.getState().pendingServerUrl).toBe(HOME);
});

it('renders nothing when no connection needs reconnecting', async () => {
  useSession.getState().clearNeedsReconnect('srv-1');
  await render(<ReconnectBanner />);
  expect(screen.queryByRole('button')).toBeNull();
});
