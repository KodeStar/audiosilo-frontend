import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AuthSession, User } from '@/api/types';
import { useSession } from '@/stores/session';

import { finishConnect } from './finish-connect';

// A change of person unloads the previous person's book (the player store, reduced).
jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    replace: (h: unknown) => mockReplace(h),
    dismissTo: (h: unknown) => mockDismissTo(h),
  },
}));

const user: User = {
  id: 1,
  username: 'chris',
  role: 'user',
  disabled: false,
  has_password: true,
  has_recovery: false,
};
const session = (id: string, extra: Partial<AuthSession> = {}): AuthSession => ({
  token: `tok-${id}`,
  server_id: id,
  user,
  ...extra,
});

const HOME = 'http://192.168.1.20:8080';
const AWAY = 'https://books.example.com';

beforeEach(async () => {
  await AsyncStorage.clear();
  mockReplace.mockClear();
  mockDismissTo.mockClear();
  useSession.setState({
    status: 'unauthenticated',
    connections: [],
    defaultConnectionId: null,
    pendingServerUrl: null,
    user: null,
  });
});

// The connection a sign-in to `serverId` made (user 1: `<server_id>.1`).
const conn = (serverId: string) =>
  useSession.getState().connections.find((c) => c.id === `${serverId}.1`);

it('ends the first sign-in on "Your library is ready." for the new connection', async () => {
  await finishConnect({
    serverUrl: AWAY,
    session: session('srv-1'),
    linkAddresses: { home: HOME, away: AWAY },
    name: 'Hearthside',
  });
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/connect/ready',
    params: { connection: 'srv-1.1' },
  });
  expect(mockDismissTo).not.toHaveBeenCalled();
  expect(conn('srv-1')).toMatchObject({
    serverUrl: AWAY,
    name: 'Hearthside',
    addresses: { home: HOME, away: AWAY },
  });
});

it('goes straight back to the app for an added server', async () => {
  await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
  mockReplace.mockClear();
  await finishConnect({ serverUrl: 'https://other.example.com', session: session('srv-2') });
  expect(mockReplace).not.toHaveBeenCalled();
  expect(mockDismissTo).toHaveBeenCalledWith('/');
});

it('names the connection after its host when the flow does not know the name', async () => {
  await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
  expect(conn('srv-1')?.name).toBe('books.example.com');
});

it('a reconnect through the away address keeps the address the server was paired with', async () => {
  await finishConnect({
    serverUrl: HOME,
    session: session('srv-1'),
    linkAddresses: { home: HOME, away: AWAY },
  });
  await finishConnect({
    serverUrl: AWAY,
    session: session('srv-1', { token: 'fresh', addresses: { away: AWAY } }),
    reconnectId: 'srv-1.1',
  });
  expect(useSession.getState().connections).toHaveLength(1);
  expect(conn('srv-1')).toMatchObject({
    serverUrl: HOME,
    token: 'fresh',
    addresses: { home: HOME, away: AWAY },
  });
});

it('a reset server reached through its away address retires the dead identity', async () => {
  await finishConnect({
    serverUrl: HOME,
    session: session('old'),
    linkAddresses: { home: HOME, away: AWAY },
  });
  useSession.getState().markNeedsReconnect('old.1', 'server-reset');
  await finishConnect({
    serverUrl: AWAY,
    session: session('new', { addresses: { away: AWAY } }),
    reconnectId: 'old.1',
  });
  const ids = useSession.getState().connections.map((c) => c.id);
  expect(ids).toEqual(['new.1']);
  expect(conn('new')).toMatchObject({
    serverUrl: HOME,
    addresses: { home: HOME, away: AWAY },
  });
});

describe('the addresses a pairing taught (link merged with the answer, once)', () => {
  const addressesAfter = async (link?: object, answer?: object) => {
    await finishConnect({
      serverUrl: AWAY,
      session: session('srv-1', answer ? { addresses: answer } : {}),
      linkAddresses: link,
    });
    return conn('srv-1')?.addresses;
  };

  it('keeps the home address a link carried when the answer (read through away) has none', async () => {
    expect(await addressesAfter({ home: HOME, away: AWAY }, { away: AWAY })).toEqual({
      home: HOME,
      away: AWAY,
    });
  });

  it("takes the answer's away address over the link's", async () => {
    expect(await addressesAfter({ away: 'https://old.example.com' }, { away: AWAY })).toEqual({
      away: AWAY,
    });
  });

  it('keeps what the link said when the answer says nothing (an older server)', async () => {
    expect(await addressesAfter({ home: HOME }, undefined)).toEqual({ home: HOME });
  });

  it('stores none when neither said anything', async () => {
    expect(await addressesAfter(undefined, undefined)).toBeUndefined();
  });
});

it('another user on a server the device has gets a connection of their own, on its paired address', async () => {
  await finishConnect({
    serverUrl: HOME,
    session: session('srv-1'),
    linkAddresses: { home: HOME, away: AWAY },
  });
  const id = await finishConnect({
    serverUrl: AWAY,
    session: session('srv-1', { token: 'kit', user: { ...user, id: 7, username: 'kit' } }),
  });
  expect(id).toBe('srv-1.7');
  const conns = useSession.getState().connections;
  expect(conns.map((c) => [c.id, c.token])).toEqual([
    ['srv-1.1', 'tok-srv-1'],
    ['srv-1.7', 'kit'],
  ]);
  // Signed in through the away address of a server already paired at home: the paired
  // address stays the server's, and the home address carries over.
  expect(conns[1]).toMatchObject({ serverUrl: HOME, addresses: { home: HOME, away: AWAY } });
});

describe('placing the new connection in a profile (Phase 8)', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const profiles = () => require('@/stores/profiles') as typeof import('@/stores/profiles');
  const intent = () =>
    require('@/components/profiles/connect-intent') as typeof import('@/components/profiles/connect-intent');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const sam: User = { ...user, id: 2, username: 'sam' };
  const people = () =>
    profiles()
      .useProfiles.getState()
      .profiles.map((p) => [p.name, p.connectionIds]);

  beforeEach(async () => {
    profiles().resetProfilesForTests();
    intent().setConnectForNewProfile(false);
    await profiles().useProfiles.getState().hydrate();
  });

  it('finding 7: a child signs in only as itself while a grown-up is on the device', async () => {
    await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
    await finishConnect({ serverUrl: AWAY, session: session('srv-1', { user: sam }) });
    const kid = profiles().activeProfile()!.id; // Sam, now a kids profile
    profiles().setProfileKids(kid, { bedtime: '20:00' });
    const before = useSession.getState().connections;
    // "Add someone" (the demo) and a new server are refused before anything is stored.
    intent().setConnectForNewProfile(true);
    await expect(
      finishConnect({ serverUrl: 'https://demo', session: session('demo') }),
    ).rejects.toThrow();
    intent().setConnectForNewProfile(false);
    await expect(
      finishConnect({ serverUrl: 'https://two', session: session('srv-2', { user: sam }) }),
    ).rejects.toThrow();
    expect(useSession.getState().connections).toBe(before);
    expect(profiles().activeProfile()?.id).toBe(kid);
    // Signing in again as itself (a dead token) still works, and stays in kids mode.
    await finishConnect({ serverUrl: AWAY, session: session('srv-1', { user: sam }) });
    expect(profiles().activeProfile()?.id).toBe(kid);
    expect(profiles().activeProfile()?.kids).toBeDefined();
  });

  it('a kids profile alone on the device may still add a grown-up (no way out otherwise)', async () => {
    await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
    profiles().setProfileKids(profiles().activeProfile()!.id, { bedtime: '20:00' });
    intent().setConnectForNewProfile(true);
    await finishConnect({ serverUrl: 'https://two', session: session('srv-2', { user: sam }) });
    expect(profiles().activeProfile()?.name).toBe('sam');
  });

  it('a new server joins the active person', async () => {
    await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
    await finishConnect({ serverUrl: 'https://two', session: session('srv-2') });
    expect(people()).toEqual([['chris', ['srv-1.1', 'srv-2.1']]]);
  });

  it('another user on a server the active person has: a new person, made active', async () => {
    await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
    await finishConnect({ serverUrl: AWAY, session: session('srv-1', { user: sam }) });
    expect(people()).toEqual([
      ['chris', ['srv-1.1']],
      ['sam', ['srv-1.2']],
    ]);
    expect(profiles().activeProfile()?.name).toBe('sam');
    expect(useSession.getState().defaultConnectionId).toBe('srv-1.2');
    expect(profiles().useProfiles.getState().askAtLaunch).toBe(true);
  });

  it('"Add someone" puts even a new server in a new person', async () => {
    await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
    intent().setConnectForNewProfile(true);
    await finishConnect({ serverUrl: 'https://two', session: session('srv-2', { user: sam }) });
    expect(people()).toEqual([
      ['chris', ['srv-1.1']],
      ['sam', ['srv-2.2']],
    ]);
    expect(profiles().activeProfile()?.name).toBe('sam');
  });

  it('a re-pair keeps its person; "Add someone" as a person already here switches to them', async () => {
    await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
    await finishConnect({ serverUrl: AWAY, session: session('srv-1', { user: sam }) });
    // Sam is active; Chris signs in again (a re-pair): Chris keeps his profile, Sam stays.
    await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
    expect(people()).toEqual([
      ['chris', ['srv-1.1']],
      ['sam', ['srv-1.2']],
    ]);
    expect(profiles().activeProfile()?.name).toBe('sam');
    intent().setConnectForNewProfile(true);
    await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
    expect(profiles().activeProfile()?.name).toBe('chris');
    expect(people()).toHaveLength(2);
  });
});
