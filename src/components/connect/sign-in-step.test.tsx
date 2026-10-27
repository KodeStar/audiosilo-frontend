import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

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

describe("an invite link's code (a scanned or pasted invite, #98)", () => {
  it('signs in with it at once, through the redeem and the exchange', async () => {
    mockApi.redeemCode.mockResolvedValue({ server_name: 'Hearthside', pairing_token: 'pt' });
    mockApi.exchange.mockResolvedValue({ token: 's', server_id: 'srv-1', user });
    await render(<SignInStep server={AWAY} initialCode="ABCD-1234" />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockApi.redeemCode).toHaveBeenCalledTimes(1);
    expect(mockApi.redeemCode).toHaveBeenCalledWith('ABCD-1234');
    expect(mockApi.exchange).toHaveBeenCalledWith('pt', 'Test device');
    expect(conn('srv-1')?.name).toBe('Hearthside');
  });

  it("never redeems it again from the field's return key while it is on its way", async () => {
    let answer: (v: unknown) => void = () => {};
    mockApi.redeemCode.mockImplementation(() => new Promise((r) => (answer = r)));
    mockApi.exchange.mockResolvedValue({ token: 's', server_id: 'srv-1', user });
    await render(<SignInStep server={AWAY} initialCode="ABCD-1234" />);
    await fireEvent(screen.getByPlaceholderText('Enter your invite code'), 'submitEditing');
    expect(mockApi.redeemCode).toHaveBeenCalledTimes(1);
    await act(async () => answer({ server_name: 'Hearthside', pairing_token: 'pt' }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockApi.redeemCode).toHaveBeenCalledTimes(1);
  });

  it('keeps a refused code in the field with the reason, and tries it once only', async () => {
    mockApi.redeemCode.mockRejectedValue(new ApiError(401, 'invalid or expired code'));
    await render(<SignInStep server={AWAY} initialCode="ABCD-1234" />);
    expect(await screen.findByText(/That invite code didn't work/)).toBeTruthy();
    expect(screen.getByPlaceholderText('Enter your invite code').props.value).toBe('ABCD-1234');
    expect(mockApi.redeemCode).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
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

/** Fill in a username and password, then press Sign in. */
const signInWith = async (username: string, password: string) => {
  await fireEvent.press(screen.getByLabelText('Username and password'));
  await fireEvent.changeText(screen.getByLabelText('Username'), username);
  await fireEvent.changeText(screen.getByLabelText('Password'), password);
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
};

// CONNECT-08: a sentence that says what to do, never the server's raw string.
it('says the name or password is wrong, and stays', async () => {
  mockApi.login.mockRejectedValue(new ApiError(401, 'invalid credentials'));
  await render(<SignInStep server={AWAY} />);
  await signInWith('chris', 'nope');
  expect(
    await screen.findByText('The username or password is wrong. Check them and try again.'),
  ).toBeTruthy();
  expect(screen.queryByText('invalid credentials')).toBeNull();
  expect(mockReplace).not.toHaveBeenCalled();
});

it("names the limiter's wait from Retry-After", async () => {
  mockApi.login.mockRejectedValue(new ApiError(429, 'too many attempts', undefined, 900));
  await render(<SignInStep server={AWAY} />);
  await signInWith('chris', 'pw');
  expect(
    await screen.findByText('Too many tries from this network. Try again in 15 minutes.'),
  ).toBeTruthy();
});

it('says an invite used up at the exchange is used up, not a bad code', async () => {
  mockApi.redeemCode.mockResolvedValue({ server_name: 'Hearthside', pairing_token: 'pt' });
  mockApi.exchange.mockRejectedValue(new ApiError(401, 'invite already used on all its devices'));
  await render(<SignInStep server={AWAY} />);
  await fireEvent.changeText(screen.getByPlaceholderText('Enter your invite code'), 'ABCD');
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText(/This invite can't add another device/)).toBeTruthy();
});

// frontend#129: a book link opened signed out ends on that book after sign-in.
it('ends on the book the signed-out visit was opening', async () => {
  mockApi.login.mockResolvedValue({ token: 's', server_id: 'srv-1', user });
  await render(<SignInStep server={AWAY} book={{ libraryId: 2, path: 'Jane Austen/Emma' }} />);
  await signInWith('chris', 'pw');
  await waitFor(() =>
    expect(mockDismissTo).toHaveBeenCalledWith({
      pathname: '/book/[libraryId]',
      params: { libraryId: '2', connection: 'srv-1.1', path: 'Jane Austen/Emma' },
    }),
  );
  expect(mockReplace).not.toHaveBeenCalled();
});

// CONNECT-09: an empty field is prompted for under itself, and nothing is sent.
it('prompts for an empty invite code and sends nothing', async () => {
  await render(<SignInStep server={AWAY} />);
  await fireEvent.changeText(screen.getByPlaceholderText('Enter your invite code'), '   ');
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
  expect(screen.getByText('Enter the invite code from your admin.')).toBeTruthy();
  expect(mockApi.redeemCode).not.toHaveBeenCalled();
  // Typing clears the prompt.
  await fireEvent.changeText(screen.getByPlaceholderText('Enter your invite code'), 'A');
  expect(screen.queryByText('Enter the invite code from your admin.')).toBeNull();
});

it('prompts for an empty username, then an empty password, and sends nothing', async () => {
  await render(<SignInStep server={AWAY} />);
  await signInWith(' ', '');
  expect(screen.getByText('Enter your username.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Username'), 'chris');
  await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
  expect(screen.getByText('Enter your password.')).toBeTruthy();
  expect(mockApi.login).not.toHaveBeenCalled();
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
  await signInWith('chris', 'pw');
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
