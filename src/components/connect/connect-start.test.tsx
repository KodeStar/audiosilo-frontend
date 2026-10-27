import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Linking, Platform } from 'react-native';

import { effectiveUrl, useAddressRoute } from '@/api/address-route';
import type { User } from '@/api/types';
import { remember } from '@/lib/known-servers';
import { useSession } from '@/stores/session';

import { ConnectStart } from './connect-start';
import { renderConnect as render } from './connect-testing';

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
const mockBack = jest.fn();
const mockSetParams = jest.fn();
let mockCanGoBack = true;
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: {
    push: (h: unknown) => mockPush(h),
    replace: (h: unknown) => mockReplace(h),
    dismissTo: (h: unknown) => mockDismissTo(h),
    back: () => mockBack(),
    canGoBack: () => mockCanGoBack,
    setParams: (p: unknown) => mockSetParams(p),
  },
  useLocalSearchParams: () => mockParams,
}));

let mockLayout = 'phone';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'Test device' }));
// The player the server serves at /web: its own origin, else (native, Metro dev) none.
let mockServed: string | null = null;
jest.mock('@/lib/base-url', () => {
  const actual = jest.requireActual('@/lib/base-url');
  return {
    ...actual,
    servedOrigin: () => mockServed,
    webOrigin: () => mockServed ?? actual.webOrigin(),
  };
});

// Each bare client the flow builds, by base URL.
const mockApi = {
  serverInfo: jest.fn(),
  exchange: jest.fn(),
  demoSession: jest.fn(),
  me: jest.fn(),
};
const mockBases: string[] = [];
jest.mock('@/api/client', () => {
  const actual = jest.requireActual('@/api/client');
  return {
    ...actual,
    ApiClient: function ApiClient(base: string) {
      mockBases.push(base);
      return mockApi;
    },
  };
});

const { ApiError, TimeoutError } = jest.requireActual('@/api/client');

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
const info = (extra: object = {}) => ({
  name: 'Hearthside',
  server_id: 'srv-1',
  version: '1.17.0',
  api: 'v1',
  capabilities: {},
  auth: { methods: [] },
  ...extra,
});

const os = Platform.OS;
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockBases.length = 0;
  mockParams = {};
  mockLayout = 'phone';
  mockCanGoBack = true;
  mockServed = null;
  Platform.OS = 'ios';
  useAddressRoute.setState({ picks: {} });
  useSession.setState({
    status: 'unauthenticated',
    connections: [],
    defaultConnectionId: null,
    pendingServerUrl: null,
    user: null,
  });
});
afterAll(() => {
  Platform.OS = os;
});

const conn = () => useSession.getState().connections[0];

describe('a pairing link', () => {
  it("exchanges the token, keeps the link's home address and the answer's away, names the server", async () => {
    mockParams = { token: 'tok', server: AWAY, home: HOME, away: AWAY };
    mockApi.exchange.mockResolvedValue({
      token: 'session',
      server_id: 'srv-1',
      user,
      addresses: { away: AWAY },
    });
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockApi.exchange).toHaveBeenCalledWith('tok', 'Test device');
    expect(conn()).toMatchObject({
      id: 'srv-1.1',
      serverId: 'srv-1',
      serverUrl: AWAY,
      name: 'Hearthside',
      addresses: { home: HOME, away: AWAY },
    });
    // The device's first connection: on to "Your library is ready."
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/connect/ready',
      params: { connection: 'srv-1.1' },
    });
  });

  it("pairs at the link's plain-http home when its https base can't connect and home is its server", async () => {
    // A server on its default self-signed certificate: the device can't trust it, so the
    // link's https base fails to connect, and the server answers plain http at home.
    const base = 'https://192.168.1.205:8080';
    const home = 'http://192.168.1.205:8080';
    mockParams = { token: 'tok', server: base, home, sid: 'srv-1' };
    mockApi.exchange
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce({ token: 'session', server_id: 'srv-1', user });
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    // The exchange at the base, home asked who it is (no token), the exchange at home.
    expect(mockBases).toEqual([base, home, home]);
    // Stored with the https base, never the plain-http address; home is the first pick.
    expect(conn()).toMatchObject({ serverUrl: base, name: 'Hearthside', addresses: { home } });
    expect(useAddressRoute.getState().picks[conn().id]).toBe(home);
    expect(effectiveUrl(conn())).toBe(home);
  });

  it("does not pair at home without the server's id in the link", async () => {
    const base = 'https://192.168.1.205:8080';
    const home = 'http://192.168.1.205:8080';
    mockParams = { token: 'tok', server: base, home };
    mockApi.exchange.mockRejectedValue(new TypeError('Network request failed'));
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    expect(await screen.findByText(/^Couldn't reach the server/)).toBeTruthy();
    expect(mockBases).toEqual([base]);
    expect(useSession.getState().connections).toHaveLength(0);
  });

  it('a link without addresses pairs exactly as before (no addresses stored)', async () => {
    mockParams = { token: 'tok', server: AWAY };
    mockApi.exchange.mockResolvedValue({ token: 's', server_id: 'srv-1', user });
    mockApi.serverInfo.mockRejectedValue(new Error('offline'));
    await render(<ConnectStart />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(conn().addresses).toBeUndefined();
    expect(conn().name).toBe('books.example.com');
  });

  it('says why a failed exchange failed and leaves the address to retry', async () => {
    mockParams = { token: 'tok', server: AWAY };
    mockApi.exchange.mockRejectedValue(new ApiError(410, 'token expired'));
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    // In the app's words, never the server's English.
    expect(
      await screen.findByText(/This pairing link has expired or was already used/),
    ).toBeTruthy();
    expect(screen.queryByText(/token expired/)).toBeNull();
    expect(screen.getByLabelText('Server address').props.value).toBe(AWAY);
    expect(useSession.getState().connections).toHaveLength(0);
    // CONNECT-14: the dead token leaves the address, so a reload doesn't try it again.
    expect(mockSetParams).toHaveBeenCalledWith({ token: undefined });
  });

  it("says too many tries when the server's limiter refuses the exchange", async () => {
    mockParams = { token: 'tok', server: AWAY };
    mockApi.exchange.mockRejectedValue(new ApiError(429, 'too many attempts, try again later'));
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    expect(
      await screen.findByText('Too many tries. Wait a few minutes and try again.'),
    ).toBeTruthy();
    expect(screen.queryByText(/too many attempts/)).toBeNull();
    // CONNECT-14: a busy server is no dead link: the token stays for a reload.
    expect(mockSetParams).not.toHaveBeenCalled();
  });

  it.each([
    ['the server failing itself', new ApiError(503, 'busy')],
    ['no answer', new TypeError('Network request failed')],
  ])('keeps the token after %s and tries the link again on request', async (_why, e) => {
    mockParams = { token: 'tok', server: AWAY };
    mockApi.exchange.mockRejectedValueOnce(e);
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    const again = await screen.findByTestId('pairing-try-again');
    expect(mockSetParams).not.toHaveBeenCalled();
    mockApi.exchange.mockRejectedValueOnce(new ApiError(401, 'invalid or expired pairing token'));
    await fireEvent.press(again);
    await waitFor(() => expect(mockApi.exchange).toHaveBeenCalledTimes(2));
    expect(mockApi.exchange).toHaveBeenLastCalledWith('tok', expect.any(String));
    // That answer was a refusal: now the token goes, and there is nothing to try again.
    await waitFor(() => expect(mockSetParams).toHaveBeenCalledWith({ token: undefined }));
    expect(screen.queryByTestId('pairing-try-again')).toBeNull();
  });

  it('a native link with no server address asks for one', async () => {
    mockParams = { token: 'tok' };
    await render(<ConnectStart />);
    expect(await screen.findByText(/missing its server address/)).toBeTruthy();
    expect(mockApi.exchange).not.toHaveBeenCalled();
  });
});

describe('the address field', () => {
  it('says what it found, and Sign in goes to the sign-in step', async () => {
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    await fireEvent.changeText(screen.getByLabelText('Server address'), 'books.example.com');
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText('Found Hearthside')).toBeTruthy();
    expect(screen.getByText('AudioSilo 1.17.0')).toBeTruthy();
    // Scrolled into view when it appears (the keyboard is usually up): see ConnectReveal.
    expect(within(screen.getByTestId('probe-reveal')).getByText('Found Hearthside')).toBeTruthy();
    expect(useSession.getState().pendingServerUrl).toBe(AWAY);
    await fireEvent.press(screen.getByLabelText('Sign in to Hearthside'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/connect/sign-in',
      params: { serverName: 'Hearthside' },
    });
  });

  it('gives the home-network hint for a home address it cannot reach', async () => {
    mockApi.serverInfo.mockRejectedValue(new TypeError('Network request failed'));
    await render(<ConnectStart />);
    await fireEvent.changeText(screen.getByLabelText('Server address'), '192.168.1.20:8080');
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText("Couldn't reach 192.168.1.20:8080")).toBeTruthy();
    expect(screen.getByText(/home-network address/)).toBeTruthy();
  });

  it('tries plain http once when an address typed without a scheme cannot connect over https', async () => {
    // The device pass: "mac-studio-3.local:18571" became https://..., and a plain-http home
    // server read as "Couldn't reach ... home-network address".
    mockApi.serverInfo
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce(info());
    await render(<ConnectStart />);
    await fireEvent.changeText(screen.getByLabelText('Server address'), 'mac-studio-3.local:18571');
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText('Found Hearthside')).toBeTruthy();
    expect(mockBases).toEqual([
      'https://mac-studio-3.local:18571',
      'http://mac-studio-3.local:18571',
    ]);
    expect(
      screen.getByText(
        'This server uses an unencrypted connection: http://mac-studio-3.local:18571',
      ),
    ).toBeTruthy();
    expect(useSession.getState().pendingServerUrl).toBe('http://mac-studio-3.local:18571');
    expect(screen.getByLabelText('Server address').props.value).toBe(
      'http://mac-studio-3.local:18571',
    );
  });

  it('tries plain http for a bare IP and port, as a self-signed server answers at home', async () => {
    mockApi.serverInfo
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce(info());
    await render(<ConnectStart />);
    await fireEvent.changeText(screen.getByLabelText('Server address'), '192.168.1.205:8080');
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText('Found Hearthside')).toBeTruthy();
    expect(mockBases).toEqual(['https://192.168.1.205:8080', 'http://192.168.1.205:8080']);
    expect(useSession.getState().pendingServerUrl).toBe('http://192.168.1.205:8080');
  });

  it('names a self-signed certificate as a likely cause only when https could not connect', async () => {
    mockApi.serverInfo.mockRejectedValue(new TypeError('Network request failed'));
    await render(<ConnectStart />);
    await fireEvent.changeText(
      screen.getByLabelText('Server address'),
      'https://books.example.com',
    );
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText("Couldn't reach books.example.com")).toBeTruthy();
    expect(screen.getByTestId('probe-self-signed')).toHaveTextContent(
      /own \(self-signed\) certificate/,
    );

    await fireEvent.changeText(screen.getByLabelText('Server address'), 'http://192.168.1.20:8080');
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText("Couldn't reach 192.168.1.20:8080")).toBeTruthy();
    expect(screen.queryByTestId('probe-self-signed')).toBeNull();

    // Typed without a scheme: plain http was tried too, so the hint has nothing to add.
    await fireEvent.changeText(screen.getByLabelText('Server address'), '192.168.1.21:8080');
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText("Couldn't reach 192.168.1.21:8080")).toBeTruthy();
    expect(screen.queryByTestId('probe-self-signed')).toBeNull();
  });

  it('names no certificate after a timeout, or on the web', async () => {
    mockApi.serverInfo.mockRejectedValue(new TimeoutError(15000));
    await render(<ConnectStart />);
    await fireEvent.changeText(
      screen.getByLabelText('Server address'),
      'https://books.example.com',
    );
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText("Couldn't reach books.example.com")).toBeTruthy();
    expect(screen.queryByTestId('probe-self-signed')).toBeNull();

    Platform.OS = 'web';
    mockApi.serverInfo.mockRejectedValue(new TypeError('Failed to fetch'));
    await fireEvent.changeText(
      screen.getByLabelText('Server address'),
      'https://books.example.org',
    );
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText("Couldn't reach books.example.org")).toBeTruthy();
    expect(screen.queryByTestId('probe-self-signed')).toBeNull();
  });

  it('says nothing about encryption for an https server', async () => {
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    await fireEvent.changeText(screen.getByLabelText('Server address'), 'books.example.com');
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText('Found Hearthside')).toBeTruthy();
    expect(screen.queryByTestId('probe-unencrypted')).toBeNull();
  });

  it('reports the https address when plain http does not answer either', async () => {
    mockApi.serverInfo.mockRejectedValue(new TypeError('Network request failed'));
    await render(<ConnectStart />);
    await fireEvent.changeText(screen.getByLabelText('Server address'), 'mac-studio-3.local:18571');
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText("Couldn't reach mac-studio-3.local:18571")).toBeTruthy();
    expect(mockBases).toHaveLength(2);
    expect(useSession.getState().pendingServerUrl).toBeNull();
  });

  it('does not try http when a scheme was typed, or when the server answered with an error', async () => {
    mockApi.serverInfo.mockRejectedValue(new TypeError('Network request failed'));
    await render(<ConnectStart />);
    await fireEvent.changeText(
      screen.getByLabelText('Server address'),
      'https://mac-studio-3.local:18571',
    );
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText("Couldn't reach mac-studio-3.local:18571")).toBeTruthy();
    expect(mockBases).toEqual(['https://mac-studio-3.local:18571']);

    mockBases.length = 0;
    mockApi.serverInfo.mockRejectedValue(new ApiError(500, 'boom'));
    await fireEvent.changeText(screen.getByLabelText('Server address'), 'books.example.com');
    await fireEvent.press(screen.getByText('Continue'));
    expect(await screen.findByText('The server answered with an error')).toBeTruthy();
    expect(mockBases).toEqual(['https://books.example.com']);
  });

  it('asks for an address when there is none', async () => {
    await render(<ConnectStart />);
    await fireEvent.press(screen.getByText('Continue'));
    expect(screen.getByText('Enter your server address')).toBeTruthy();
    expect(mockApi.serverInfo).not.toHaveBeenCalled();
  });

  it('offers the demo when the server runs one, carrying its addresses', async () => {
    mockApi.serverInfo.mockResolvedValue(info({ demo: { enabled: true } }));
    mockApi.demoSession.mockResolvedValue({
      token: 'demo',
      server_id: 'srv-demo',
      user,
      addresses: { away: AWAY },
      pairing: {},
    });
    await render(<ConnectStart />);
    await fireEvent.changeText(screen.getByLabelText('Server address'), AWAY);
    await fireEvent.press(screen.getByText('Continue'));
    await fireEvent.press(await screen.findByText('Try the demo'));
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(conn()).toMatchObject({
      id: 'srv-demo.1',
      name: 'Hearthside',
      addresses: { away: AWAY },
    });
  });
});

describe('remembered servers', () => {
  it('a reconnect row goes straight on to sign-in', async () => {
    await remember({ serverId: 'srv-1', serverUrl: AWAY, name: 'Hearthside' });
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    await fireEvent.press(await screen.findByLabelText('Reconnect to Hearthside'));
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/connect/sign-in',
        params: { serverName: 'Hearthside' },
      }),
    );
  });

  it('signs in through the home address when the server answers there as itself', async () => {
    await remember({
      serverId: 'srv-1',
      serverUrl: AWAY,
      name: 'Hearthside',
      addresses: { home: HOME, away: AWAY },
    });
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    await fireEvent.press(await screen.findByLabelText('Reconnect to Hearthside'));
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(mockBases[0]).toBe(HOME);
    expect(useSession.getState().pendingServerUrl).toBe(HOME);
  });

  it('goes away from home when another box answers at the home address', async () => {
    await remember({
      serverId: 'srv-1',
      serverUrl: AWAY,
      name: 'Hearthside',
      addresses: { home: HOME, away: AWAY },
    });
    mockApi.serverInfo
      .mockResolvedValueOnce(info({ server_id: 'someone-else' }))
      .mockResolvedValue(info());
    await render(<ConnectStart />);
    await fireEvent.press(await screen.findByLabelText('Reconnect to Hearthside'));
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(useSession.getState().pendingServerUrl).toBe(AWAY);
  });

  it('"Add someone" offers the same servers as a sign-in, not a reconnect', async () => {
    await remember({ serverId: 'srv-1', serverUrl: AWAY, name: 'Hearthside' });
    mockApi.serverInfo.mockResolvedValue(info());
    mockParams = { add: '1', profile: 'new' };
    await render(<ConnectStart />);
    await fireEvent.press(await screen.findByLabelText('Sign in to Hearthside'));
    expect(screen.getByText('Servers on this device')).toBeTruthy();
    expect(screen.queryByText('Reconnect')).toBeNull();
    expect(screen.queryByLabelText('Reconnect to Hearthside')).toBeNull();
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/connect/sign-in',
        params: { serverName: 'Hearthside' },
      }),
    );
  });

  it('hides a server this device is signed in to', async () => {
    await remember({ serverId: 'srv-1', serverUrl: AWAY, name: 'Hearthside' });
    await useSession
      .getState()
      .setSession({ serverUrl: AWAY, serverId: 'srv-1', token: 't', user, name: 'Hearthside' });
    await render(<ConnectStart />);
    await act(async () => {});
    expect(screen.queryByLabelText('Reconnect to Hearthside')).toBeNull();
  });
});

describe('adding a server', () => {
  const signIn = () =>
    useSession
      .getState()
      .setSession({ serverUrl: AWAY, serverId: 'srv-1', token: 't', user, name: 'Hearthside' });

  it('has no Cancel on the first run', async () => {
    await render(<ConnectStart />);
    expect(screen.queryByTestId('connect-cancel')).toBeNull();
  });

  it('cancels back to where the listener came from', async () => {
    await signIn();
    mockParams = { add: '1' };
    await render(<ConnectStart />);
    await fireEvent.press(screen.getByLabelText('Cancel adding a server'));
    expect(mockBack).toHaveBeenCalled();
    expect(mockDismissTo).not.toHaveBeenCalled();
  });

  it('cancels to the app when there is nothing to go back to (a cold link)', async () => {
    await signIn();
    mockCanGoBack = false;
    mockParams = { add: '1' };
    await render(<ConnectStart />);
    await fireEvent.press(screen.getByLabelText('Cancel adding a server'));
    expect(mockDismissTo).toHaveBeenCalledWith('/');
    expect(mockBack).not.toHaveBeenCalled();
  });
});

describe('the web', () => {
  beforeEach(() => {
    Platform.OS = 'web';
  });

  it('pairs from a pasted link', async () => {
    mockApi.exchange.mockResolvedValue({ token: 's', server_id: 'srv-1', user });
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    expect(screen.queryByText('Scan a QR code')).toBeNull();
    await fireEvent.press(screen.getByText('I have a pairing link'));
    await fireEvent.changeText(
      screen.getByLabelText('Pairing link'),
      `${AWAY}/web/connect?token=abc&home=${encodeURIComponent(HOME)}`,
    );
    await fireEvent.press(screen.getByText('Connect'));
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockBases).toContain(AWAY);
    expect(mockApi.exchange).toHaveBeenCalledWith('abc', 'Test device');
    expect(conn().addresses).toEqual({ home: HOME });
  });

  it('signs in with a pasted invite link on the sign-in step (#98)', async () => {
    await render(<ConnectStart />);
    await fireEvent.press(screen.getByText('I have a pairing link'));
    await fireEvent.changeText(
      screen.getByLabelText('Pairing link'),
      `${AWAY}/connect#code=ABCD-EFGH-JKMN-PQRS`,
    );
    await fireEvent.press(screen.getByText('Connect'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/connect/sign-in'));
    expect(useSession.getState().pendingServerUrl).toBe(AWAY);
    // The code never goes in the route (it would stay in the browser's history).
    expect(JSON.stringify(mockPush.mock.calls)).not.toContain('ABCD');
    expect(mockApi.exchange).not.toHaveBeenCalled();
  });

  it('says so when the pasted text is not a pairing link', async () => {
    await render(<ConnectStart />);
    await fireEvent.press(screen.getByText('I have a pairing link'));
    await fireEvent.changeText(screen.getByLabelText('Pairing link'), 'hello');
    await fireEvent.press(screen.getByText('Connect'));
    expect(screen.getByText(/isn't an AudioSilo pairing link/)).toBeTruthy();
    expect(mockApi.exchange).not.toHaveBeenCalled();
  });
});

describe('the player the server serves', () => {
  const ORIGIN = 'https://books.example.com';
  beforeEach(() => {
    Platform.OS = 'web';
    mockServed = ORIGIN;
  });

  it('asks its own server, shows what it found with Sign in, and asks for no address', async () => {
    mockApi.serverInfo.mockResolvedValue(info());
    await remember({ serverId: 'srv-1', serverUrl: ORIGIN, name: 'Hearthside' });
    await render(<ConnectStart />);
    await waitFor(() => expect(screen.getByText('Found Hearthside')).toBeTruthy());
    expect(mockBases).toEqual([ORIGIN]);
    expect(screen.queryByLabelText('Server address')).toBeNull();
    expect(screen.queryByText('Continue')).toBeNull();
    // The remembered server can only be this one, which the card already offers.
    expect(screen.queryByText(/Reconnect to/)).toBeNull();
    expect(screen.getByText(/Sign in with the code or password/)).toBeTruthy();
    // A pairing link for this server still pairs.
    expect(screen.getByText('I have a pairing link')).toBeTruthy();
    expect(useSession.getState().pendingServerUrl).toBe(ORIGIN);
    await fireEvent.press(screen.getByText('Sign in'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/connect/sign-in',
      params: { serverName: 'Hearthside' },
    });
  });

  it('offers the demo when the server runs one, without going on by itself', async () => {
    mockApi.serverInfo.mockResolvedValue(info({ demo: { enabled: true } }));
    await render(<ConnectStart />);
    await waitFor(() => expect(screen.getByText('Try the demo')).toBeTruthy());
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('falls back to the address field, filled in with its origin, when its server does not answer', async () => {
    mockApi.serverInfo.mockRejectedValue(new TypeError('Failed to fetch'));
    await remember({ serverId: 'srv-2', serverUrl: HOME, name: 'Elsewhere' });
    await render(<ConnectStart />);
    await waitFor(() => expect(screen.getByLabelText('Server address')).toBeTruthy());
    expect(screen.getByLabelText('Server address').props.value).toBe(ORIGIN);
    expect(screen.getByText("Couldn't reach books.example.com")).toBeTruthy();
    // It can reach no other server, so it offers none.
    expect(screen.queryByText(/Reconnect to/)).toBeNull();
  });

  describe('a pasted link for another server (CONNECT-03: this page reaches only its own)', () => {
    const paste = async (text: string) => {
      mockApi.serverInfo.mockResolvedValue(info());
      await render(<ConnectStart />);
      await waitFor(() => expect(screen.getByText('Found Hearthside')).toBeTruthy());
      mockBases.length = 0;
      await fireEvent.press(screen.getByText('I have a pairing link'));
      await fireEvent.changeText(screen.getByLabelText('Pairing link'), text);
      await fireEvent.press(screen.getByText('Connect'));
    };

    it('says so and opens the link, asking nothing of that server', async () => {
      const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
      try {
        const link = `${HOME}/web/connect?token=abc`;
        await paste(link);
        expect(screen.getByText(/This link is for another server/)).toBeTruthy();
        expect(screen.queryByText(/Could not reach/)).toBeNull();
        expect(mockBases).toEqual([]);
        expect(mockApi.exchange).not.toHaveBeenCalled();
        await fireEvent.press(screen.getByText('Open the link'));
        expect(open).toHaveBeenCalledWith(link);
        // Editing the link takes the note away again.
        await fireEvent.changeText(screen.getByLabelText('Pairing link'), 'x');
        expect(screen.queryByText(/This link is for another server/)).toBeNull();
      } finally {
        open.mockRestore();
      }
    });

    // frontend#129: a browser can't open an app link, so there is no button for one.
    it('offers no "Open the link" for an audiosilo:// link', async () => {
      await paste(`audiosilo://connect?server=${encodeURIComponent(HOME)}&token=abc`);
      expect(screen.getByText(/opens only in the AudioSilo app/)).toBeTruthy();
      expect(screen.queryByText('Open the link')).toBeNull();
      expect(mockApi.exchange).not.toHaveBeenCalled();
    });

    it("does the same for another server's invite link", async () => {
      await paste(`${HOME}/connect#code=ABCD-1234`);
      expect(screen.getByText(/This link is for another server/)).toBeTruthy();
      expect(mockPush).not.toHaveBeenCalledWith('/connect/sign-in');
    });

    it("pairs a link for this page's own server as before", async () => {
      mockApi.exchange.mockResolvedValue({ token: 's', server_id: 'srv-1', user });
      await paste(`${ORIGIN}/web/connect?token=abc`);
      await waitFor(() => expect(mockApi.exchange).toHaveBeenCalledWith('abc', 'Test device'));
      expect(screen.queryByText(/This link is for another server/)).toBeNull();
    });

    it('keeps the card it found, unasked again, when its own pasted link is dead', async () => {
      mockApi.exchange.mockRejectedValue(new ApiError(401, 'invalid or expired pairing token'));
      await paste(`${ORIGIN}/web/connect?token=abc`);
      expect(
        await screen.findByText(/This pairing link has expired or was already used/),
      ).toBeTruthy();
      expect(screen.getByText('Found Hearthside')).toBeTruthy();
      // Its first ask and the exchange's name read; no third ask for the card.
      expect(mockApi.serverInfo).toHaveBeenCalledTimes(2);
    });
  });

  // CONNECT-14: a used or expired link on the served player.
  it("shows its own server's card with Sign in after a dead link, and drops the token", async () => {
    mockParams = { token: 'used' };
    mockApi.exchange.mockRejectedValue(new ApiError(401, 'invalid or expired pairing token'));
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    await waitFor(() => expect(screen.getByText('Found Hearthside')).toBeTruthy());
    expect(screen.getByText(/This pairing link has expired or was already used/)).toBeTruthy();
    expect(screen.queryByLabelText('Server address')).toBeNull();
    expect(screen.getByText('Sign in')).toBeTruthy();
    expect(mockSetParams).toHaveBeenCalledWith({ token: undefined });
    expect(mockApi.exchange).toHaveBeenCalledTimes(1);
  });

  it('keeps the token and shows no card when its own server is busy', async () => {
    mockParams = { token: 'tok' };
    mockApi.exchange.mockRejectedValue(new ApiError(429, 'slow down'));
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    expect(await screen.findByTestId('pairing-try-again')).toBeTruthy();
    expect(screen.queryByText('Found Hearthside')).toBeNull();
    expect(mockSetParams).not.toHaveBeenCalled();
  });

  // frontend#129: a book link opened signed out comes back to the book after sign-in.
  it('carries the book a signed-out visit was opening on to the sign-in step', async () => {
    mockParams = { book: '2', path: 'Jane Austen/Emma' };
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    await waitFor(() => expect(screen.getByText('Found Hearthside')).toBeTruthy());
    await fireEvent.press(screen.getByText('Sign in'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/connect/sign-in',
      params: { serverName: 'Hearthside', book: '2', path: 'Jane Austen/Emma' },
    });
  });

  it('exchanges a pairing link at its origin without asking who it is first', async () => {
    mockParams = { token: 'tok' };
    mockApi.exchange.mockResolvedValue({ token: 's', server_id: 'srv-1', user });
    mockApi.serverInfo.mockResolvedValue(info());
    await render(<ConnectStart />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockApi.exchange).toHaveBeenCalledWith('tok', 'Test device');
    expect(screen.queryByText('Found Hearthside')).toBeNull();
  });

  describe('a link that names a book (the console\'s "Listen in player")', () => {
    const BOOK = 'Brandon Sanderson/Mistborn & Co/01 #1?';
    const bookAt = (connection: string) => ({
      pathname: '/book/[libraryId]',
      params: { libraryId: '2', connection, path: BOOK },
    });
    /** The console's link, as route params. */
    const linkParams = (over: Record<string, string> = {}) => ({
      token: 'tok',
      sid: 'srv-1',
      uid: '1',
      book: '2',
      path: BOOK,
      ...over,
    });
    const signIn = (as: User = user) =>
      useSession.getState().setSession({
        serverUrl: ORIGIN,
        serverId: 'srv-1',
        token: 't',
        user: as,
        name: 'Hearthside',
      });

    beforeEach(() => {
      mockApi.exchange.mockResolvedValue({ token: 's', server_id: 'srv-1', user });
      mockApi.serverInfo.mockResolvedValue(info());
    });

    it('pairs and ends on the book, not "Your library is ready."', async () => {
      mockParams = linkParams();
      await render(<ConnectStart />);
      await waitFor(() => expect(mockDismissTo).toHaveBeenCalledWith(bookAt('srv-1.1')));
      expect(mockApi.exchange).toHaveBeenCalledWith('tok', 'Test device');
      expect(mockReplace).not.toHaveBeenCalled();
      expect(conn()).toMatchObject({ id: 'srv-1.1', token: 's' });
    });

    it('opens the book without spending the token when already signed in as that user', async () => {
      await signIn();
      mockParams = linkParams();
      await render(<ConnectStart />);
      await waitFor(() => expect(mockDismissTo).toHaveBeenCalledWith(bookAt('srv-1.1')));
      expect(mockApi.exchange).not.toHaveBeenCalled();
      expect(useSession.getState().connections).toHaveLength(1);
      expect(conn().token).toBe('t');
    });

    it('does the same for the link pasted', async () => {
      await signIn();
      const q = new URLSearchParams(linkParams());
      await render(<ConnectStart />);
      await waitFor(() => expect(screen.getByText('Found Hearthside')).toBeTruthy());
      await fireEvent.press(screen.getByText('I have a pairing link'));
      await fireEvent.changeText(
        screen.getByLabelText('Pairing link'),
        `${ORIGIN}/web/connect?${q.toString()}`,
      );
      await fireEvent.press(screen.getByText('Connect'));
      await waitFor(() => expect(mockDismissTo).toHaveBeenCalledWith(bookAt('srv-1.1')));
      expect(mockApi.exchange).not.toHaveBeenCalled();
      expect(conn().token).toBe('t');
    });

    it.each([
      ['someone else is signed in there', () => signIn({ ...user, id: 2, username: 'sam' })],
      [
        'the server refused its token',
        async () => {
          await signIn();
          useSession.getState().markNeedsReconnect('srv-1.1', 'auth');
        },
      ],
      [
        'the server refuses its stored token (a fresh tab never knows)',
        async () => {
          await signIn();
          mockApi.me.mockRejectedValueOnce(new ApiError(401, 'invalid or expired token'));
        },
      ],
    ])('pairs when %s', async (_, before) => {
      await before();
      mockParams = linkParams();
      await render(<ConnectStart />);
      await waitFor(() => expect(mockDismissTo).toHaveBeenCalledWith(bookAt('srv-1.1')));
      expect(mockApi.exchange).toHaveBeenCalledWith('tok', 'Test device');
    });

    it('ignores a book it cannot name, and ends as any pairing link does', async () => {
      mockParams = linkParams({ book: '2x' });
      await render(<ConnectStart />);
      await waitFor(() =>
        expect(mockReplace).toHaveBeenCalledWith({
          pathname: '/connect/ready',
          params: { connection: 'srv-1.1' },
        }),
      );
      expect(mockDismissTo).not.toHaveBeenCalled();
    });
  });
});

it('asks for the address under the Metro dev server', async () => {
  Platform.OS = 'web';
  await render(<ConnectStart />);
  expect(screen.getByLabelText('Server address').props.value).toBe('');
  expect(mockApi.serverInfo).not.toHaveBeenCalled();
});

it('shows the cover cascade beside the steps on a desktop, not on a phone', async () => {
  await render(<ConnectStart />);
  expect(screen.queryByTestId('cover-cascade')).toBeNull();
  mockLayout = 'desktop';
  await render(<ConnectStart />);
  expect(screen.getByTestId('cover-cascade')).toBeTruthy();
  expect(screen.getByLabelText('Step 1 of 3')).toBeTruthy();
});
