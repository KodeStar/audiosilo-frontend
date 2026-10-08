import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { Capabilities, MyDevice, ServerAddresses, User } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';

// Each server's /server answer, by connection id (undefined: not known yet).
let mockCaps: Record<string, Partial<Capabilities> | undefined>;
let mockDevices: Record<string, MyDevice[]>;
let mockAddresses: Record<string, ServerAddresses | undefined>;
const mockRevoke = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    useServerInfo: (cid: string) => ({
      data: mockCaps[cid] ? { version: '1.17.0', capabilities: mockCaps[cid] } : undefined,
    }),
    // The real hook never asks a server without the flag: its query stays pending.
    useMyDevices: (cid: string) =>
      mockCaps[cid]?.my_devices
        ? { data: mockDevices[cid], isPending: false, isError: false, isSuccess: true }
        : { data: undefined, isPending: true, isError: false, isSuccess: false },
    useRevokeMyDevice: () => ({ mutateAsync: mockRevoke, isPending: false }),
    // Gated like the real hook: nothing without the flag.
    useServerAddresses: (cid: string) => ({
      data: mockCaps[cid]?.addresses ? mockAddresses[cid] : undefined,
    }),
    useApiKeys: (enabled: boolean) => ({ data: enabled ? [] : undefined, isLoading: false }),
    useCreateApiKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
    useRevokeApiKey: () => ({ mutate: jest.fn() }),
  };
});

const mockLogout = jest.fn(async () => {});
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => ({ logout: mockLogout, me: jest.fn(), pair: jest.fn() }),
}));

type Conn = {
  id: string;
  name: string;
  serverUrl: string;
  user: User;
  addresses?: ServerAddresses;
};
let mockSession: {
  connections: Conn[];
  defaultConnectionId: string | null;
  setConnectionUser: jest.Mock;
  removeConnection: jest.Mock;
};
jest.mock('@/stores/session', () => ({
  useSession: (selector: (s: unknown) => unknown) => selector(mockSession),
  onConnectionRemoved: () => () => {},
}));

jest.mock('@/playback/store', () => ({ teardownBeforeTokenRevoke: jest.fn(async () => {}) }));
jest.mock('@/downloads/store', () => ({
  useDownloads: (selector: (s: unknown) => unknown) => selector({ entries: {} }),
  downloadedCountFor: () => 0,
}));

/* eslint-disable import/first */
import { Platform } from 'react-native';

import { setAddressPick, useAddressRoute } from '@/api/address-route';
import { teardownBeforeTokenRevoke } from '@/playback/store';

import { AccountSection } from './account-section';
import { IdentityCard } from './identity-card';
/* eslint-enable import/first */

const user = (over: Partial<User> = {}): User => ({
  id: 1,
  username: 'chris',
  role: 'admin',
  disabled: false,
  has_password: true,
  has_recovery: false,
  ...over,
});

const session = (id: number, current = false): MyDevice => ({
  id,
  kind: 'session',
  name: current ? 'This phone' : `Device ${id}`,
  client: null,
  created_at: '2026-10-01T10:00:00Z',
  last_seen: null,
  last_ip: '',
  current,
});

const FULL: Partial<Capabilities> = { my_devices: true, api_keys: true };

const os = Platform.OS;
afterAll(() => {
  Platform.OS = os;
});

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'ios';
  useAddressRoute.setState({ picks: {} });
  mockAddresses = {};
  mockCaps = { c1: FULL, c2: { my_devices: false, api_keys: false } };
  mockDevices = {
    c1: [
      session(1, true),
      session(2),
      { ...session(3), kind: 'api', name: 'Dashboard' } satisfies MyDevice,
    ],
  };
  mockSession = {
    connections: [
      { id: 'c1', name: 'Hearthside', serverUrl: 'https://books.example', user: user() },
      {
        id: 'c2',
        name: "Maya's",
        serverUrl: 'http://maya.local:8080',
        user: user({ username: 'chris2', role: 'user' }),
      },
    ],
    defaultConnectionId: 'c1',
    setConnectionUser: jest.fn(async () => {}),
    removeConnection: jest.fn(async () => {}),
  };
});

describe('AccountSection: at home and away', () => {
  const HOME = 'http://192.168.1.20:8080';
  const AWAY = 'https://books.example';
  const withAddresses = (addresses?: ServerAddresses) => {
    mockCaps.c1 = { ...FULL, addresses: true };
    mockSession.connections[0].serverUrl = AWAY;
    mockSession.connections[0].addresses = addresses;
  };

  it('shows both addresses and the one this device uses now (native)', async () => {
    withAddresses({ home: HOME, away: AWAY });
    setAddressPick('c1', HOME);
    await mountWithPortal(<AccountSection connectionId="c1" />);
    expect(screen.getByText('At home and away')).toBeTruthy();
    expect(screen.getByLabelText(`Home address: ${HOME}, In use`)).toBeTruthy();
    expect(screen.getByLabelText(`Away address: ${AWAY}`)).toBeTruthy();
    expect(
      screen.getByText('Using your home address. The app switches between them by itself.'),
    ).toBeTruthy();
  });

  it('adds what the server says now to what the device kept', async () => {
    withAddresses({ home: HOME });
    // Read through the away address: the answer can't know home.
    mockAddresses.c1 = { away: AWAY };
    await mountWithPortal(<AccountSection connectionId="c1" />);
    expect(screen.getByLabelText(`Home address: ${HOME}`)).toBeTruthy();
    expect(screen.getByLabelText(`Away address: ${AWAY}, In use`)).toBeTruthy();
    expect(screen.getByText(/^Using your away address/)).toBeTruthy();
  });

  it('shows the addresses without an "in use" line on the web (it never switches)', async () => {
    Platform.OS = 'web';
    withAddresses({ home: HOME, away: AWAY });
    await mountWithPortal(<AccountSection connectionId="c1" />);
    expect(screen.getByTestId('addresses-card')).toBeTruthy();
    expect(screen.getByLabelText(`Away address: ${AWAY}`)).toBeTruthy();
    expect(screen.queryByTestId('address-in-use')).toBeNull();
    expect(screen.queryByText('In use')).toBeNull();
  });

  it('is hidden without the capability, or with nothing known', async () => {
    mockSession.connections[0].addresses = { home: HOME, away: AWAY };
    await mountWithPortal(<AccountSection connectionId="c1" />);
    expect(screen.queryByTestId('addresses-card')).toBeNull();
    withAddresses(undefined);
    await mountWithPortal(<AccountSection connectionId="c1" />);
    expect(screen.queryByTestId('addresses-card')).toBeNull();
  });
});

describe('AccountSection', () => {
  it('shows every block on a server that has them all', async () => {
    await mountWithPortal(<AccountSection connectionId="c1" />);
    // Sessions only: the API key is listed in its own section.
    expect(
      screen.getByText('@chris · Administrator on Hearthside · signed in on 2 devices'),
    ).toBeTruthy();
    expect(screen.getByText('Password')).toBeTruthy();
    expect(screen.getByText('Pair another device')).toBeTruthy();
    expect(screen.getByText('Signed-in devices')).toBeTruthy();
    expect(screen.getByText('Personal API keys')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create API key' })).toBeTruthy();
    expect(screen.getByText('Sign out of Hearthside')).toBeTruthy();
    expect(screen.getByText('AudioSilo v1.17.0')).toBeTruthy();
  });

  it('degrades quietly on an older server', async () => {
    await mountWithPortal(<AccountSection connectionId="c2" />);
    expect(screen.getByText("@chris2 · User on Maya's")).toBeTruthy();
    expect(screen.queryByText('Signed-in devices')).toBeNull();
    expect(screen.getByText("Not available on Maya's")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create API key' })).toBeNull();
    // Pairing and signing out work everywhere.
    expect(screen.getByText('Pair another device')).toBeTruthy();
    expect(screen.getByText("Sign out of Maya's")).toBeTruthy();
  });

  it('shows neither the devices nor an API keys notice while the server is unknown', async () => {
    mockCaps.c1 = undefined;
    await mountWithPortal(<AccountSection connectionId="c1" />);
    expect(screen.getByText('@chris · Administrator on Hearthside')).toBeTruthy();
    expect(screen.queryByText('Signed-in devices')).toBeNull();
    expect(screen.queryByText('Personal API keys')).toBeNull();
  });

  it('hides the password and API keys from a demo account', async () => {
    mockSession.connections[0].user = user({ is_demo: true, role: 'user' });
    await mountWithPortal(<AccountSection connectionId="c1" />);
    expect(screen.getByText('Demo')).toBeTruthy();
    expect(screen.queryByText('Password')).toBeNull();
    expect(screen.queryByText('Personal API keys')).toBeNull();
    expect(screen.queryByText(/Not available/)).toBeNull();
  });

  it('switches between signed-in servers when no server is given', async () => {
    await mountWithPortal(<AccountSection />);
    expect(screen.getByRole('radio', { name: 'Hearthside' })).toBeChecked();
    expect(screen.getByText('Sign out of Hearthside')).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: "Maya's" }));
    expect(screen.getByText("Sign out of Maya's")).toBeTruthy();
    expect(screen.getByText('maya.local:8080')).toBeTruthy();
  });

  it('has no switcher for one server, or when the route names one', async () => {
    const view = await mountWithPortal(<AccountSection connectionId="c2" />);
    expect(screen.queryByRole('radio')).toBeNull();
    mockSession.connections = [mockSession.connections[0]];
    await view.rerender(<AccountSection />);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('Sign out of Hearthside')).toBeTruthy();
  });

  it('says so when no server is signed in', async () => {
    mockSession.connections = [];
    mockSession.defaultConnectionId = null;
    await mountWithPortal(<AccountSection />);
    expect(screen.getByText('Sign in to a server to see its account.')).toBeTruthy();
  });

  // This device signs out through useSignOut (teardown first: final position, queued
  // progress), never through the my-devices revoke.
  it('signs this device out through the guarded sign-out, never the device revoke', async () => {
    await mountWithPortal(<AccountSection connectionId="c1" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out of Hearthside' }));
    await waitFor(() => expect(mockSession.removeConnection).toHaveBeenCalledWith('c1'));
    expect(teardownBeforeTokenRevoke).toHaveBeenCalledWith('c1');
    expect(mockLogout).toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("offers a password-less user the password editor before they're stranded", async () => {
    mockSession.connections[0].user = user({ role: 'user', has_password: false });
    await mountWithPortal(<AccountSection connectionId="c1" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out of Hearthside' }));
    expect(await screen.findByText('Sign out?')).toBeTruthy();
    expect(mockSession.removeConnection).not.toHaveBeenCalled();
    // The warning's own "Set a password" (the card has one too).
    const setButtons = screen.getAllByRole('button', { name: 'Set a password' });
    await fireEvent.press(setButtons[setButtons.length - 1]);
    expect(await screen.findByLabelText('New password')).toBeTruthy();
    expect(mockSession.removeConnection).not.toHaveBeenCalled();
  });
});

describe('IdentityCard', () => {
  it('gives the device count its own sentence-case line on a narrow card', async () => {
    await mountWithPortal(
      <IdentityCard user={user()} serverName="Hearthside" deviceCount={1} stacked />,
    );
    expect(screen.getByText('@chris · Administrator on Hearthside')).toBeTruthy();
    expect(screen.getByText('Signed in on 1 device')).toBeTruthy();
  });
});
