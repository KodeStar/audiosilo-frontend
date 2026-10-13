import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderRouter, waitFor } from 'expo-router/testing-library';
import { Platform, Text } from 'react-native';

import type { AuthSession, User } from '@/api/types';
import { nav, realRouteTree, router } from '@/testing/route-tree';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'Test device' }));
// The connect layout's kids-mode toast (none here): its overlay needs the native animations.
jest.mock('@/components/ui/toast', () => ({ toast: jest.fn() }));

const dad: User = {
  id: 1,
  username: 'dad',
  role: 'user',
  disabled: false,
  has_password: true,
  has_recovery: false,
};
const mom: User = { ...dad, id: 5, username: 'mom' };

const mockApi = {
  serverInfo: jest.fn(),
  exchange: jest.fn(),
  demoSession: jest.fn(),
  login: jest.fn(),
  redeemCode: jest.fn(),
};
jest.mock('@/api/client', () => {
  const actual = jest.requireActual('@/api/client');
  return {
    ...actual,
    ApiClient: function ApiClient() {
      return mockApi;
    },
  };
});

/* eslint-disable import/first */
import ConnectRoute from '@/app/connect/index';
import ConnectLayout from '@/app/connect/_layout';
import { connectForNewProfile } from '@/components/profiles/connect-intent';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import { scanParams } from './connect-model';
import { finishConnect } from './finish-connect';
/* eslint-enable import/first */

// "Add someone" signs a NEW person in, whichever way the flow goes on from /connect: the
// intent must survive the flow's own navigations (the QR scan replaces its screen with a
// /connect that carries only the link; "Use another server" comes back with no params).

const people = () => {
  const s = useProfiles.getState();
  return s.profiles.map((p) => [p.name, p.connectionIds, p.id === s.activeProfileId]);
};

const os = Platform.OS;
beforeEach(async () => {
  Platform.OS = 'ios';
  await AsyncStorage.clear();
  jest.clearAllMocks();
  resetProfilesForTests();
  useSession.setState({
    status: 'unauthenticated',
    connections: [],
    defaultConnectionId: null,
    pendingServerUrl: null,
    user: null,
  });
  // Dad is signed in to server A and is the person listening.
  await useSession
    .getState()
    .setSession({ serverUrl: 'https://a', serverId: 'A', token: 't', user: dad, name: 'Server A' });
  await useProfiles.getState().hydrate();
  mockApi.serverInfo.mockResolvedValue({
    name: 'Server B',
    server_id: 'B',
    version: '2.2.0',
    api: 'v1',
    capabilities: {},
    auth: { methods: [] },
  });
  mockApi.exchange.mockResolvedValue({ token: 'mom-session', server_id: 'B', user: mom });
});
afterAll(() => {
  Platform.OS = os;
});

async function mount(overrides: Record<string, unknown> = {}) {
  const tree = realRouteTree() as Record<string, unknown>;
  tree['connect/_layout'] = ConnectLayout;
  tree['connect/index'] = ConnectRoute;
  tree['connect/scan'] = () => <Text>scan</Text>;
  Object.assign(tree, overrides);
  await (renderRouter(tree as Parameters<typeof renderRouter>[0], {
    initialUrl: '/',
  }) as unknown as Promise<unknown>);
}

it('"Add someone", then a scanned pairing code: the new person gets a profile of their own', async () => {
  await mount();
  await nav(() => router.push('/connect?add=1&profile=new'));
  await nav(() => router.push('/connect/scan'));
  // What the scanner does with a good code.
  await nav(() =>
    router.replace({
      pathname: '/connect',
      params: scanParams({ base: 'https://b', token: 'tok' } as Parameters<typeof scanParams>[0]),
    }),
  );
  await waitFor(() =>
    expect(useSession.getState().connections.some((c) => c.id === 'B.5')).toBe(true),
  );
  await nav(() => {});
  expect(people()).toEqual([
    ['dad', ['A.1'], false],
    ['mom', ['B.5'], true],
  ]);
});

it('"Add someone", then "Use another server" on the sign-in step: still a new person', async () => {
  await mount({ 'connect/sign-in': () => <Text>sign in</Text> });
  await nav(() => router.push('/connect?add=1&profile=new'));
  // The connect screen keeps the address it found while the sign-in step is over it.
  await nav(async () => {
    await useSession.getState().setPendingServerUrl('https://wrong');
  });
  await nav(() => router.push({ pathname: '/connect/sign-in', params: { serverName: 'Wrong' } }));
  // What the sign-in step's "Use another server" does.
  await nav(() => router.dismissTo('/connect'));
  expect(connectForNewProfile()).toBe(true);
  await nav(async () => {
    await finishConnect({
      serverUrl: 'https://b',
      session: { token: 'mom-session', server_id: 'B', user: mom } as AuthSession,
      name: 'Server B',
    });
  });
  expect(people()).toEqual([
    ['dad', ['A.1'], false],
    ['mom', ['B.5'], true],
  ]);
});

it('leaving the flow forgets "Add someone"', async () => {
  await mount();
  await nav(() => router.push('/connect?add=1&profile=new'));
  expect(connectForNewProfile()).toBe(true);
  await nav(() => router.dismissTo('/'));
  expect(connectForNewProfile()).toBe(false);
});

it('"Add a server" in the same flow is the person listening again', async () => {
  await mount();
  await nav(() => router.push('/connect?add=1&profile=new'));
  expect(connectForNewProfile()).toBe(true);
  // Still inside the connect flow (its layout stays mounted): an explicit "Add a server".
  await nav(() => router.replace('/connect?add=1'));
  expect(connectForNewProfile()).toBe(false);
});
