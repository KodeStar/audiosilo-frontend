import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { User } from '@/api/types';
import { remember } from '@/lib/known-servers';
import { useSession } from '@/stores/session';

import { ConnectStart } from './connect-start';
import { renderConnect as render } from './connect-testing';

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
const mockBack = jest.fn();
let mockCanGoBack = true;
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: {
    push: (h: unknown) => mockPush(h),
    replace: (h: unknown) => mockReplace(h),
    dismissTo: (h: unknown) => mockDismissTo(h),
    back: () => mockBack(),
    canGoBack: () => mockCanGoBack,
  },
  useLocalSearchParams: () => mockParams,
}));

let mockLayout = 'phone';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'Test device' }));

// Each bare client the flow builds, by base URL.
const mockApi = {
  serverInfo: jest.fn(),
  exchange: jest.fn(),
  demoSession: jest.fn(),
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
  Platform.OS = 'ios';
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
      id: 'srv-1',
      serverUrl: AWAY,
      name: 'Hearthside',
      addresses: { home: HOME, away: AWAY },
    });
    // The device's first connection: on to "Your library is ready."
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/connect/ready',
      params: { connection: 'srv-1' },
    });
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
    expect(await screen.findByText(/token expired/)).toBeTruthy();
    expect(screen.getByLabelText('Server address').props.value).toBe(AWAY);
    expect(useSession.getState().connections).toHaveLength(0);
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
    expect(conn()).toMatchObject({ id: 'srv-demo', name: 'Hearthside', addresses: { away: AWAY } });
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

  it('says so when the pasted text is not a pairing link', async () => {
    await render(<ConnectStart />);
    await fireEvent.press(screen.getByText('I have a pairing link'));
    await fireEvent.changeText(screen.getByLabelText('Pairing link'), 'hello');
    await fireEvent.press(screen.getByText('Connect'));
    expect(screen.getByText(/isn't an AudioSilo pairing link/)).toBeTruthy();
    expect(mockApi.exchange).not.toHaveBeenCalled();
  });
});

it('shows the cover cascade beside the steps on a desktop, not on a phone', async () => {
  await render(<ConnectStart />);
  expect(screen.queryByTestId('cover-cascade')).toBeNull();
  mockLayout = 'desktop';
  await render(<ConnectStart />);
  expect(screen.getByTestId('cover-cascade')).toBeTruthy();
  expect(screen.getByLabelText('Step 1 of 3')).toBeTruthy();
});
