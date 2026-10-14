import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { effectiveUrl, useAddressRoute } from '@/api/address-route';
import type { AuthSession, User } from '@/api/types';
import { checkPin, setPin } from '@/lib/profile-pin';
import { CONNECTIONS_KEY, PROFILES_KEY } from '@/lib/storage-keys';
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
  useAddressRoute.setState({ picks: {} });
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

it('makes the address that answered the first pick, never the stored serverUrl', async () => {
  // A pairing link's https base could not connect; its plain-http home answered.
  const base = 'https://192.168.1.205:8080';
  const home = 'http://192.168.1.205:8080';
  const id = await finishConnect({
    serverUrl: base,
    session: session('srv-1'),
    linkAddresses: { home },
    answeredAt: home,
  });
  expect(conn('srv-1')).toMatchObject({ serverUrl: base, addresses: { home } });
  expect(useAddressRoute.getState().picks[id]).toBe(home);
  expect(effectiveUrl(conn('srv-1')!)).toBe(home);
});

it('sets no pick without an address that answered', async () => {
  const id = await finishConnect({
    serverUrl: AWAY,
    session: session('srv-1'),
    linkAddresses: { home: HOME, away: AWAY },
  });
  expect(useAddressRoute.getState().picks[id]).toBeUndefined();
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
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const { resetProfilesForTests, useProfiles } = require('@/stores/profiles');
  resetProfilesForTests();
  await useProfiles.getState().hydrate();
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

  describe('a server that was reset (another server_id at the same address)', () => {
    const kit: User = { ...user, id: 9, username: 'kit' };
    /** Chris (PIN) and Sam on one server, Sam listening; then the server is rebuilt. */
    const household = async () => {
      await finishConnect({ serverUrl: AWAY, session: session('old') });
      await finishConnect({ serverUrl: AWAY, session: session('old', { user: sam }) });
      const chris = profiles().profileOf('old.1')!.id;
      await setPin(chris, '1357');
      profiles().setProfileHasPin(chris, true);
      useSession.getState().markNeedsReconnect('old.1', 'server-reset');
      useSession.getState().markNeedsReconnect('old.2', 'server-reset');
      return { chris, sam: profiles().profileOf('old.2')!.id };
    };

    it("re-pairing retires only the signer's dead identity, never another person", async () => {
      const ids = await household();
      const removed: string[] = [];
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      const off = require('@/stores/session').onConnectionRemoved((id: string) => {
        removed.push(id);
      });
      try {
        // Sam's reconnect banner: the rebuilt server, Sam's new account there.
        await finishConnect({
          serverUrl: AWAY,
          session: session('new', { user: kit }),
          reconnectId: 'old.2',
        });
      } finally {
        off();
      }
      expect(removed).toEqual(['old.2']);
      // Sam's profile now holds the new connection; Chris is still on the device, PIN and
      // all, his connection kept (flagged for him to sign in again).
      expect(people()).toEqual([
        ['chris', ['old.1']],
        ['sam', ['new.9']],
      ]);
      expect(profiles().profileOf('new.9')?.id).toBe(ids.sam);
      expect(profiles().activeProfile()?.id).toBe(ids.sam);
      expect(await checkPin(ids.chris, '1357')).toBe(true);
      expect(profiles().profileOf('old.1')?.hasPin).toBe(true);
      const old = useSession.getState().connections.find((c) => c.id === 'old.1');
      expect(old?.needsReconnect).toBe('server-reset');
      expect(await SecureStore.getItemAsync('audiosilo.token.old.1')).toBe('tok-old');
    });

    it('"Add someone" on a reset server retires nobody\'s identity', async () => {
      await household();
      intent().setConnectForNewProfile(true);
      await finishConnect({ serverUrl: AWAY, session: session('new', { user: kit }) });
      expect(people()).toEqual([
        ['chris', ['old.1']],
        ['sam', ['old.2']],
        ['kit', ['new.9']],
      ]);
    });

    it('a kids profile signs in again to its own reset server, and stays in kids mode', async () => {
      const ids = await household();
      profiles().setProfileKids(ids.sam, {
        library: { connectionId: 'old.2', libraryId: 3 },
        bedtime: '19:00',
      });
      await finishConnect({
        serverUrl: AWAY,
        session: session('new', { user: kit }),
        reconnectId: 'old.2',
      });
      const kid = profiles().activeProfile();
      expect(kid?.id).toBe(ids.sam);
      expect(kid?.connectionIds).toEqual(['new.9']);
      expect(kid?.kids).toEqual({
        library: { connectionId: 'new.9', libraryId: 3 },
        bedtime: '19:00',
      });
    });
  });

  describe("a kid's account (household members, Phase 8b-1)", () => {
    const evie: User = {
      ...user,
      id: 12,
      username: 'evie',
      has_password: false,
      managed_by: { id: 1, username: 'chris' },
      member_kind: 'kid',
    };

    it("starts in kids mode on the kid's own device, with no grown-up there, skipping the ready step", async () => {
      await finishConnect({ serverUrl: AWAY, session: session('srv-1', { user: evie }) });
      const kid = profiles().activeProfile();
      expect(kid?.connectionIds).toEqual(['srv-1.12']);
      expect(kid?.kids).toEqual({ bedtime: profiles().DEFAULT_BEDTIME });
      // Straight to kids mode (D9): never the grown-up "Your library is ready." step,
      // which kids mode doesn't allow, nor Home on the way.
      expect(mockReplace).not.toHaveBeenCalled();
      expect(mockDismissTo.mock.calls).toEqual([['/kids']]);
    });

    it('starts in kids mode when a grown-up signs the kid in on their device', async () => {
      await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
      intent().setConnectForNewProfile(true);
      await finishConnect({ serverUrl: AWAY, session: session('srv-1', { user: evie }) });
      expect(people()).toEqual([
        ['chris', ['srv-1.1']],
        ['evie', ['srv-1.12']],
      ]);
      expect(profiles().profileOf('srv-1.12')?.kids).toBeDefined();
      expect(profiles().profileOf('srv-1.1')?.kids).toBeUndefined();
    });

    it('a re-pair keeps what its person had (kids mode turned off stays off)', async () => {
      await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
      intent().setConnectForNewProfile(true);
      await finishConnect({ serverUrl: AWAY, session: session('srv-1', { user: evie }) });
      const kid = profiles().profileOf('srv-1.12')!.id;
      profiles().setProfileKids(kid, undefined);
      intent().setConnectForNewProfile(false);
      await finishConnect({
        serverUrl: AWAY,
        session: session('srv-1', { user: evie, token: 'fresh' }),
        reconnectId: 'srv-1.12',
      });
      expect(profiles().profileOf('srv-1.12')?.kids).toBeUndefined();
    });

    it("never puts a grown-up's profile in kids mode when a kid's sign-in joins it", async () => {
      await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
      // A kid's account on another server joins the person listening (their first there).
      await finishConnect({ serverUrl: 'https://two', session: session('srv-2', { user: evie }) });
      expect(people()).toEqual([['chris', ['srv-1.1', 'srv-2.12']]]);
      expect(profiles().activeProfile()?.kids).toBeUndefined();
    });

    it('an ordinary account (or an older server: no member_kind) never starts in kids mode', async () => {
      await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
      const grown: User = { ...evie, id: 13, username: 'ellis', member_kind: 'grownup' };
      await finishConnect({ serverUrl: AWAY, session: session('srv-1', { user: grown }) });
      expect(profiles().activeProfile()?.name).toBe('ellis');
      expect(profiles().activeProfile()?.kids).toBeUndefined();
      expect(profiles().profileOf('srv-1.1')?.kids).toBeUndefined();
    });
  });

  it("a re-pair after the session's read failed stays with its own person, PIN and all", async () => {
    const bea: User = { ...user, id: 7, username: 'bea' };
    const a = { id: 'srvA.1', serverId: 'srvA', serverUrl: 'https://a', name: 'A', user };
    const b = { id: 'srvB.7', serverId: 'srvB', serverUrl: 'https://b', name: 'B', user: bea };
    await AsyncStorage.setItem(CONNECTIONS_KEY, JSON.stringify([a, b]));
    await SecureStore.setItemAsync('audiosilo.token.srvA.1', 'ta');
    await SecureStore.setItemAsync('audiosilo.token.srvB.7', 'tb');
    const household = [
      { id: 'pa', name: 'Alex', connectionIds: ['srvA.1'] },
      { id: 'pb', name: 'Bea', connectionIds: ['srvB.7'], hasPin: true },
    ];
    await AsyncStorage.setItem(
      PROFILES_KEY,
      JSON.stringify({ version: 1, profiles: household, activeProfileId: 'pa', askAtLaunch: true }),
    );
    await setPin('pb', '2468');
    profiles().resetProfilesForTests();
    useSession.setState({ status: 'loading', connections: [] });
    // One token read throws at launch: the session's read fails (the connect screen shows).
    const get = SecureStore.getItemAsync as jest.Mock;
    const read = get.getMockImplementation()!;
    let thrown = false;
    get.mockImplementation((k: string) => {
      if (k === 'audiosilo.token.srvA.1' && !thrown) {
        thrown = true;
        return Promise.reject(new Error('keystore busy'));
      }
      return read(k);
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await Promise.all([
        useSession.getState().hydrate(),
        profiles().useProfiles.getState().hydrate(),
      ]);
      expect(thrown).toBe(true);
      // Bea signs in again from there: her connection stays hers, and so does her PIN.
      await finishConnect({ serverUrl: 'https://b', session: session('srvB', { user: bea }) });
      expect(profiles().useProfiles.getState().profiles).toEqual(household);
      expect(profiles().activeProfile()?.name).toBe('Alex');
      expect(await checkPin('pb', '2468')).toBe(true);
    } finally {
      get.mockImplementation(read);
      warn.mockRestore();
    }
  });
});
