import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { User } from '@/api/types';
import { useSession } from '@/stores/session';

import { renderConnect as render } from './connect-testing';
import { SignInStep } from './sign-in-step';

const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
const mockBack = jest.fn();
let mockCanGoBack = true;
jest.mock('expo-router', () => ({
  router: {
    replace: (h: unknown) => mockReplace(h),
    dismissTo: (h: unknown) => mockDismissTo(h),
    back: () => mockBack(),
    canGoBack: () => mockCanGoBack,
  },
}));
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'Test device' }));
let mockServed: string | null = null;
jest.mock('@/lib/base-url', () => ({
  ...jest.requireActual('@/lib/base-url'),
  servedOrigin: () => mockServed,
}));

const mockApi = { redeemCode: jest.fn(), exchange: jest.fn(), login: jest.fn() };
const mockBases: string[] = [];
jest.mock('@/api/client', () => ({
  ...jest.requireActual('@/api/client'),
  ApiClient: function ApiClient(base: string) {
    mockBases.push(base);
    return mockApi;
  },
}));
const { ApiError } = jest.requireActual('@/api/client');

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

beforeEach(async () => {
  mockServed = null;
  mockCanGoBack = true;
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockBases.length = 0;
  useSession.setState({
    status: 'unauthenticated',
    connections: [],
    defaultConnectionId: null,
    pendingServerUrl: AWAY,
    user: null,
  });
});

// The connection a sign-in to `serverId` made (the test user: `<server_id>.1`).
const conn = (serverId: string) =>
  useSession.getState().connections.find((c) => c.id === `${serverId}.1`);

it('names the server and its host, and talks to the server being connected to', async () => {
  await render(<SignInStep server={AWAY} serverName="Hearthside" />);
  expect(screen.getByText('Hearthside · books.example.com')).toBeTruthy();
  expect(mockBases).toEqual([AWAY]);
  expect(screen.getByLabelText('Step 2 of 3')).toBeTruthy();
});

it('an invite code: the redeem payload and the exchange answer teach the addresses', async () => {
  mockApi.redeemCode.mockResolvedValue({
    server_name: 'Hearthside',
    pairing_token: 'pt',
    addresses: { home: HOME, away: AWAY },
  });
  mockApi.exchange.mockResolvedValue({
    token: 's',
    server_id: 'srv-1',
    user,
    addresses: { away: AWAY },
  });
  await render(<SignInStep server={AWAY} />);
  await fireEvent.changeText(screen.getByPlaceholderText('Enter your invite code'), ' 7QX-4KD ');
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  expect(mockApi.redeemCode).toHaveBeenCalledWith('7QX-4KD');
  expect(mockApi.exchange).toHaveBeenCalledWith('pt', 'Test device');
  expect(conn('srv-1')).toMatchObject({
    name: 'Hearthside',
    addresses: { home: HOME, away: AWAY },
  });
});

it('a password: the login answer teaches the addresses', async () => {
  mockApi.login.mockResolvedValue({
    token: 's',
    server_id: 'srv-1',
    user,
    addresses: { home: HOME, away: AWAY },
  });
  await render(<SignInStep server={AWAY} serverName="Hearthside" />);
  await fireEvent.press(screen.getByLabelText('Username and password'));
  await fireEvent.changeText(screen.getByLabelText('Username'), ' chris ');
  await fireEvent.changeText(screen.getByLabelText('Password'), 'pw');
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  expect(mockApi.login).toHaveBeenCalledWith('chris', 'pw', 'Test device');
  expect(conn('srv-1')?.addresses).toEqual({ home: HOME, away: AWAY });
});

it("shows the server's error and stays", async () => {
  mockApi.login.mockRejectedValue(new ApiError(401, 'invalid credentials'));
  await render(<SignInStep server={AWAY} />);
  await fireEvent.press(screen.getByLabelText('Username and password'));
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('invalid credentials')).toBeTruthy();
  expect(mockReplace).not.toHaveBeenCalled();
});

it('a reconnect away from home: "At home and away" up front, and the paired address kept', async () => {
  await useSession.getState().setSession({
    serverUrl: HOME,
    serverId: 'srv-1',
    token: 'dead',
    user,
    name: 'Hearthside',
    addresses: { home: HOME, away: AWAY },
  });
  mockApi.login.mockResolvedValue({ token: 'fresh', server_id: 'srv-1', user });
  await render(<SignInStep server={AWAY} serverName="Hearthside" reconnectId="srv-1.1" />);
  expect(screen.getByTestId('addresses-card')).toBeTruthy();
  expect(screen.getByText(HOME)).toBeTruthy();
  expect(screen.getByText(AWAY)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Username and password'));
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
  // Not the first connection: straight back to the app.
  await waitFor(() => expect(mockDismissTo).toHaveBeenCalledWith('/'));
  expect(conn('srv-1')).toMatchObject({ serverUrl: HOME, token: 'fresh' });
});

it('no "At home and away" card for a new server before anything is redeemed', async () => {
  await render(<SignInStep server={AWAY} />);
  expect(screen.queryByTestId('addresses-card')).toBeNull();
});

it('"Another server" goes back to the first step', async () => {
  await render(<SignInStep server={AWAY} />);
  await fireEvent.press(screen.getByText('Another server'));
  expect(mockDismissTo).toHaveBeenCalledWith('/connect');
  expect(mockBack).not.toHaveBeenCalled();
});

it('is only "Back" on the player the server serves, which has no other server', async () => {
  mockServed = AWAY;
  await render(<SignInStep server={AWAY} />);
  expect(screen.queryByText('Another server')).toBeNull();
  // Back to where it came from: the found card, or the app the reconnect banner was in.
  await fireEvent.press(screen.getByText('Back'));
  expect(mockBack).toHaveBeenCalled();
  expect(mockDismissTo).not.toHaveBeenCalled();
});

it('goes to the first step from "Back" with nothing to go back to (a cold link)', async () => {
  mockServed = AWAY;
  mockCanGoBack = false;
  await render(<SignInStep server={AWAY} />);
  await fireEvent.press(screen.getByText('Back'));
  expect(mockDismissTo).toHaveBeenCalledWith('/connect');
  expect(mockBack).not.toHaveBeenCalled();
});
