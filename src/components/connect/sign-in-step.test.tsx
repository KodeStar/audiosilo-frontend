import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { User } from '@/api/types';
import {
  endConnectFlow,
  openAddSomeone,
  setConnectForNewProfile,
} from '@/components/profiles/connect-intent';
import { getSignInKey } from '@/lib/sign-in-key';
import { resetProfilesForTests } from '@/stores/profiles';
import { useSession } from '@/stores/session';
import { seedProfile } from '@/testing/seed-profile';

import { inConnectFrame, renderConnect as render } from './connect-testing';
import { takeScanFor } from './invite-handoff';
import { SignInStep } from './sign-in-step';

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockDismissTo = jest.fn();
const mockBack = jest.fn();
let mockCanGoBack = true;
jest.mock('expo-router', () => ({
  router: {
    replace: (h: unknown) => mockReplace(h),
    push: (h: unknown) => mockPush(h),
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

const mockApi = {
  redeemCode: jest.fn(),
  exchange: jest.fn(),
  login: jest.fn(),
  serverInfo: jest.fn(),
  oidcStartUrl: () => `${AWAY}/api/v1/auth/oidc/start?return=web`,
};
const mockBases: string[] = [];
// The proxy headers (fe#167) each client was built with (its sixth argument).
const mockProxies: unknown[] = [];
jest.mock('@/api/client', () => ({
  ...jest.requireActual('@/api/client'),
  ApiClient: function ApiClient(base: string, ...rest: unknown[]) {
    mockBases.push(base);
    mockProxies.push(rest[4] ?? null);
    // Sends a set whenever it is given one (connect-client.test.ts holds the origin rule).
    return Object.assign(Object.create(mockApi), {
      proxyHeadersFor: () => (rest[4] ? {} : undefined),
    });
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
  // The served player asks its own server whether single sign-on is on: here it is not.
  mockApi.serverInfo.mockResolvedValue({ capabilities: {}, auth: { methods: [] } });
  mockBases.length = 0;
  mockProxies.length = 0;
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
  // With this install's key for that server (fe#159): a sign-in again is no new device to
  // the admin, and no other server is sent it.
  const key = await getSignInKey(AWAY);
  expect(mockApi.login).toHaveBeenCalledWith('chris', 'pw', 'Test device', key);
  expect(await getSignInKey(HOME)).not.toBe(key);
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

// fe#159: a second redeem of the same code spent another of the invite's uses (and refused
// a single-use invite as used), so a token whose exchange got no answer is exchanged again.
describe('an invite whose exchange got no answer', () => {
  const submitCode = async (code: string) => {
    await fireEvent.changeText(screen.getByPlaceholderText('Enter your invite code'), code);
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
  };

  it('exchanges the pairing token again on the next try, never redeeming twice', async () => {
    mockApi.redeemCode.mockResolvedValue({ server_name: 'Hearthside', pairing_token: 'pt' });
    mockApi.exchange
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce({ token: 's', server_id: 'srv-1', user });
    await render(<SignInStep server={AWAY} />);
    await submitCode('ABCD');
    expect(await screen.findByText('Sign in failed. Please try again.')).toBeTruthy();
    await submitCode('ABCD');
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockApi.redeemCode).toHaveBeenCalledTimes(1);
    expect(mockApi.exchange.mock.calls).toEqual([
      ['pt', 'Test device'],
      ['pt', 'Test device'],
    ]);
  });

  it('redeems afresh when the kept token is refused (expired meanwhile)', async () => {
    mockApi.redeemCode
      .mockResolvedValueOnce({ server_name: 'Hearthside', pairing_token: 'pt-1' })
      .mockResolvedValueOnce({ server_name: 'Hearthside', pairing_token: 'pt-2' });
    mockApi.exchange
      .mockRejectedValueOnce(new ApiError(503, 'unavailable'))
      .mockRejectedValueOnce(new ApiError(401, 'invalid or expired pairing token'))
      .mockResolvedValueOnce({ token: 's', server_id: 'srv-1', user });
    await render(<SignInStep server={AWAY} />);
    await submitCode('ABCD');
    expect(await screen.findByText('Sign in failed. Please try again.')).toBeTruthy();
    await submitCode('ABCD');
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockApi.exchange.mock.calls.map((c) => c[0])).toEqual(['pt-1', 'pt-1', 'pt-2']);
  });

  it('never exchanges a kept token at another server', async () => {
    mockApi.redeemCode
      .mockResolvedValueOnce({ server_name: 'Hearthside', pairing_token: 'pt-away' })
      .mockResolvedValueOnce({ server_name: 'Hearthside', pairing_token: 'pt-home' });
    mockApi.exchange
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce({ token: 's', server_id: 'srv-1', user });
    const view = await render(<SignInStep server={AWAY} />);
    await submitCode('ABCD');
    expect(await screen.findByText('Sign in failed. Please try again.')).toBeTruthy();
    await view.rerender(inConnectFrame(<SignInStep server={HOME} />));
    await submitCode('ABCD');
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockApi.exchange.mock.calls.map((c) => c[0])).toEqual(['pt-away', 'pt-home']);
  });

  it('redeems another code typed instead, and never keeps a token the server refused', async () => {
    mockApi.redeemCode.mockResolvedValue({ server_name: 'Hearthside', pairing_token: 'pt' });
    mockApi.exchange
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockRejectedValueOnce(new ApiError(401, 'invite already used on all its devices'))
      .mockRejectedValueOnce(new ApiError(401, 'invite already used on all its devices'));
    await render(<SignInStep server={AWAY} />);
    await submitCode('ABCD');
    expect(await screen.findByText('Sign in failed. Please try again.')).toBeTruthy();
    await submitCode('WXYZ');
    expect(await screen.findByText(/This invite can't add another device/)).toBeTruthy();
    await submitCode('WXYZ');
    await waitFor(() => expect(mockApi.exchange).toHaveBeenCalledTimes(3));
    expect(mockApi.redeemCode.mock.calls).toEqual([['ABCD'], ['WXYZ'], ['WXYZ']]);
  });
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

it("a reconnect signs in with its own proxy headers only, never another person's (fe#167)", async () => {
  const theirs = { origin: AWAY, headers: [{ name: 'X-Theirs', value: 'their-secret' }] };
  const mine = { origin: AWAY, headers: [{ name: 'X-Mine', value: 'my-secret' }] };
  const s = useSession.getState();
  await s.setSession({ serverUrl: AWAY, serverId: 'srv-1', token: 't', user, proxyHeaders: null });
  const other = { ...user, id: 2, username: 'sam' };
  await s.setSession(
    { serverUrl: AWAY, serverId: 'srv-1', token: 't2', user: other, proxyHeaders: theirs },
    { makeDefault: false },
  );
  // Denied: srv-1.1 has none; sam's set for the same address stays with sam.
  const view = await render(<SignInStep server={AWAY} reconnectId="srv-1.1" />);
  expect(mockProxies).toEqual([null]);
  view.unmount();
  // Allowed: its own set, once it has one.
  await s.setProxyHeaders('srv-1.1', mine);
  await render(<SignInStep server={AWAY} reconnectId="srv-1.1" />);
  expect(mockProxies[1]).toEqual(mine);
});

it("borrows another connection's set only while it is still here when the sign-in is sent (fe#295)", async () => {
  const theirs = { origin: AWAY, headers: [{ name: 'X-Theirs', value: 'their-secret' }] };
  const other = { ...user, id: 2, username: 'sam' };
  const s = useSession.getState();
  await s.setSession({
    serverUrl: AWAY,
    serverId: 'srv-1',
    token: 't2',
    user: other,
    proxyHeaders: theirs,
  });
  mockApi.login.mockResolvedValue({ token: 'fresh', server_id: 'srv-1', user });
  // Allowed: Sam is still signed in, so his set gets this sign-in through the proxy.
  const view = await render(<SignInStep server={AWAY} />);
  mockProxies.length = 0;
  await signInWith('chris', 'pw');
  await waitFor(() => expect(conn('srv-1')).toBeTruthy());
  expect(mockProxies).toEqual([theirs]);
  expect(conn('srv-1')?.proxyHeaders).toEqual(theirs);
  view.unmount();
  // Denied: Sam signs out while the step is open; the sign-in then neither sends nor keeps it.
  await s.removeConnection('srv-1.1');
  await render(<SignInStep server={AWAY} />);
  await s.removeConnection('srv-1.2');
  mockProxies.length = 0;
  await signInWith('chris', 'pw');
  await waitFor(() => expect(conn('srv-1')).toBeTruthy());
  expect(mockProxies).toEqual([null]);
  expect(conn('srv-1')?.proxyHeaders).toBeUndefined();
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

describe('no password (fe#264)', () => {
  const os = Platform.OS;
  afterEach(() => {
    Platform.OS = os;
  });

  it('says the invite code needs no password', async () => {
    await render(<SignInStep server={AWAY} />);
    expect(
      screen.getByText("From the invite your admin sent you. You don't need a password."),
    ).toBeTruthy();
  });

  it('offers the scanner in the app, and sends nothing', async () => {
    Platform.OS = 'ios';
    await render(<SignInStep server={AWAY} />);
    await fireEvent.press(screen.getByText('No password? Scan a QR code instead'));
    expect(mockPush).toHaveBeenCalledWith('/connect/scan');
    expect(takeScanFor()).toBeUndefined();
    expect(mockApi.redeemCode).not.toHaveBeenCalled();
    expect(mockApi.login).not.toHaveBeenCalled();
  });

  it('offers it on a reconnect too, and tells the scanner which connection it re-pairs', async () => {
    Platform.OS = 'android';
    await render(<SignInStep server={AWAY} reconnectId="srv.1" />);
    await fireEvent.press(screen.getByTestId('sign-in-scan'));
    // A code for the same server then re-pairs this connection, as a code typed here does.
    // Handed over in memory, never in the route: a link opens the scanner too.
    expect(mockPush).toHaveBeenCalledWith('/connect/scan');
    expect(takeScanFor()).toBe('srv.1');
  });

  // fe#299: a sign-in heading to a book still ends on it after a scan.
  it('hands the scanner the book the sign-in was heading to', async () => {
    Platform.OS = 'ios';
    await render(<SignInStep server={AWAY} book={{ libraryId: 2, path: 'A/Book' }} />);
    await fireEvent.press(screen.getByTestId('sign-in-scan'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/connect/scan',
      params: { book: '2', path: 'A/Book' },
    });
  });

  it('holds the scanner back while a sign-in is on its way', async () => {
    Platform.OS = 'ios';
    let answer: (v: unknown) => void = () => {};
    mockApi.redeemCode.mockImplementation(() => new Promise((r) => (answer = r)));
    mockApi.exchange.mockResolvedValue({ token: 's', server_id: 'srv-1', user });
    await render(<SignInStep server={AWAY} initialCode="ABCD-1234" />);
    await fireEvent.press(screen.getByTestId('sign-in-scan'));
    expect(mockPush).not.toHaveBeenCalled();
    await act(async () => answer({ server_name: 'Hearthside', pairing_token: 'pt' }));
  });

  it('offers no scanner on the web (no camera step there)', async () => {
    Platform.OS = 'web';
    await render(<SignInStep server={AWAY} />);
    expect(screen.queryByTestId('sign-in-scan')).toBeNull();
  });
});

// Single sign-on (server#235): offered only by the player the server serves, signing in to
// its own origin, on a server whose `oidc` capability is on; a full page load of the
// server's start route.
describe('single sign-on', () => {
  const os = Platform.OS;
  const realLocation = (globalThis as { location?: unknown }).location;
  const assign = jest.fn();
  const serverInfo = (oidc: boolean | undefined, name?: string) => ({
    name: 'Hearthside',
    server_id: 'srv-1',
    version: '2.7.0',
    api: 'v1',
    capabilities: oidc === undefined ? {} : { oidc },
    auth: name ? { methods: ['auth_code', 'password', 'oidc'], oidc: { name } } : { methods: [] },
  });
  beforeEach(() => {
    Platform.OS = 'web';
    mockServed = AWAY;
    (globalThis as { location?: unknown }).location = { assign };
  });
  afterEach(() => {
    Platform.OS = os;
    (globalThis as { location?: unknown }).location = realLocation;
  });

  it('offers "Sign in with <name>" when it is on, and loads the start page', async () => {
    mockApi.serverInfo.mockResolvedValue(serverInfo(true, 'Keycloak'));
    await render(<SignInStep server={AWAY} serverName="Hearthside" />);
    const button = await screen.findByRole('button', { name: 'Sign in with Keycloak' });
    expect(mockBases).toEqual([AWAY]);
    await fireEvent.press(button);
    expect(assign).toHaveBeenCalledWith(`${AWAY}/api/v1/auth/oidc/start?return=web`);
    expect(mockApi.login).not.toHaveBeenCalled();
  });

  it('names single sign-on itself when the server sent no name', async () => {
    mockApi.serverInfo.mockResolvedValue(serverInfo(true));
    await render(<SignInStep server={AWAY} />);
    expect(await screen.findByTestId('sign-in-oidc')).toBeTruthy();
    expect(screen.getByText('Sign in with single sign-on')).toBeTruthy();
  });

  it.each([
    ['off', false],
    ['absent (an older server)', undefined],
  ])('is not offered with the capability %s', async (_, oidc) => {
    mockApi.serverInfo.mockResolvedValue(serverInfo(oidc, 'Keycloak'));
    await render(<SignInStep server={AWAY} />);
    await waitFor(() => expect(mockApi.serverInfo).toHaveBeenCalled());
    expect(screen.queryByTestId('sign-in-oidc')).toBeNull();
  });

  it('is not offered when the server does not answer', async () => {
    mockApi.serverInfo.mockRejectedValue(new Error('offline'));
    await render(<SignInStep server={AWAY} />);
    await waitFor(() => expect(mockApi.serverInfo).toHaveBeenCalled());
    expect(screen.queryByTestId('sign-in-oidc')).toBeNull();
  });

  it.each([
    ['in the app or under the Metro dev server (no served origin)', () => (mockServed = null)],
    ['for a server on another origin', () => (mockServed = 'https://other.example.com')],
  ])('is not offered, nor asked about, %s', async (_, arrange) => {
    arrange();
    mockApi.serverInfo.mockResolvedValue(serverInfo(true, 'Keycloak'));
    await render(<SignInStep server={AWAY} />);
    expect(mockApi.serverInfo).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sign-in-oidc')).toBeNull();
  });

  // The return is a page load: what the flow is for goes with the page in this tab's
  // storage (fe#310).
  describe('what goes with the page', () => {
    const store = new Map<string, string>();
    const held = () => JSON.parse(store.get('audiosilo.oidcIntent')!);
    beforeEach(() => {
      store.clear();
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => void store.set(k, v),
          removeItem: (k: string) => void store.delete(k),
        },
        configurable: true,
      });
      mockApi.serverInfo.mockResolvedValue(serverInfo(true, 'Keycloak'));
    });
    afterEach(() => {
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
      endConnectFlow();
      resetProfilesForTests();
    });
    const leave = async () => {
      await fireEvent.press(await screen.findByRole('button', { name: 'Sign in with Keycloak' }));
      expect(assign).toHaveBeenCalled();
    };

    it("is a grown-up's pass through kids mode, offered there, and the book", async () => {
      seedProfile({ kids: true });
      openAddSomeone();
      // What `/connect?add=1&profile=new` sets as the flow opens.
      setConnectForNewProfile(true);
      await render(<SignInStep server={AWAY} book={{ libraryId: 3, path: 'Austen/Emma' }} />);
      await leave();
      expect(held()).toEqual({
        at: expect.any(Number),
        newPerson: true,
        grownUpFromKids: true,
        book: { book: '3', path: 'Austen/Emma' },
      });
    });

    // The in-memory hold (`holdReconnect`) is lost to the page load (fe#298).
    it('is the connection a reconnect re-pairs, with the address it signs in through', async () => {
      await render(<SignInStep server={AWAY} reconnectId="srv-old.1" />);
      await leave();
      expect(held()).toEqual({
        at: expect.any(Number),
        newPerson: false,
        grownUpFromKids: false,
        reconnect: { server: AWAY, reconnectId: 'srv-old.1' },
      });
    });
  });
});
