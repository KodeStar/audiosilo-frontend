import AsyncStorage from '@react-native-async-storage/async-storage';

import { act, renderHook } from '@testing-library/react-native';

import type { User } from '@/api/types';
import { initialProfiles, PROFILES_KEY } from '@/lib/identity-migration';
import {
  activeProfile,
  connectionsOfProfile,
  parseProfilesDoc,
  placeConnection,
  placeInDoc,
  profileConnectionIds,
  profileOf,
  type ProfilesDoc,
  reconcileProfiles,
  renameProfile,
  resetProfilesForTests,
  setAskAtLaunch,
  setProfileHasPin,
  setProfileKids,
  switchProfile,
  useActiveProfile,
  useProfileConnections,
  useProfiles,
} from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';

// The player store, as far as a profile switch uses it: what is loaded, and `stop` (pause,
// save, unload).
const mockPlayer = {
  nowPlaying: null as { connectionId: string } | null,
  stop: jest.fn(async () => {
    mockPlayer.nowPlaying = null;
  }),
};
jest.mock('@/playback/store', () => ({ usePlayer: { getState: () => mockPlayer } }));

const user = (id: number, username: string): User => ({
  id,
  username,
  role: 'user',
  disabled: false,
  has_password: true,
  has_recovery: false,
});

const conn = (serverId: string, userId: number, username: string): Connection => ({
  id: `${serverId}.${userId}`,
  serverId,
  serverUrl: `https://${serverId}`,
  name: serverId,
  token: 't',
  user: user(userId, username),
});

const A1 = conn('srvA', 1, 'chris');
const A2 = conn('srvA', 2, 'sam');
const B1 = conn('srvB', 7, 'chris');
const C3 = conn('srvC', 3, 'jo');

let n = 0;
const ids = () => `p${++n}`;

const doc = (over: Partial<ProfilesDoc> = {}): ProfilesDoc => ({
  version: 1,
  profiles: [],
  activeProfileId: null,
  askAtLaunch: false,
  ...over,
});

function setSession(connections: Connection[], defaultId: string | null = null) {
  useSession.setState({
    status: connections.length ? 'authenticated' : 'unauthenticated',
    connections,
    defaultConnectionId: defaultId ?? connections[0]?.id ?? null,
    user: null,
  });
}

beforeEach(async () => {
  n = 0;
  mockPlayer.nowPlaying = null;
  mockPlayer.stop.mockClear();
  await AsyncStorage.clear();
  resetProfilesForTests();
  useSession.setState({
    status: 'loading',
    connections: [],
    defaultConnectionId: null,
    user: null,
  });
});

describe('parseProfilesDoc', () => {
  it('reads the document the identity migration writes', () => {
    const first = initialProfiles([A1, B1, A2], A1.id, ids);
    expect(parseProfilesDoc(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  it('treats anything unreadable as an empty document', () => {
    for (const raw of [null, 3, 'x', [], { version: 2, profiles: [] }, { version: 1 }]) {
      expect(parseProfilesDoc(raw)).toEqual(doc());
    }
  });

  it('drops broken profiles, duplicate ids and an unknown active id; keeps kids + hasPin', () => {
    const parsed = parseProfilesDoc({
      version: 1,
      profiles: [
        { id: 'a', name: 'Chris', connectionIds: ['x', 'x', 3], hasPin: true },
        { id: 'a', name: 'dupe', connectionIds: [] },
        { name: 'no id' },
        {
          id: 'k',
          name: 'Leo',
          connectionIds: ['y'],
          kids: { bedtime: '7pm', library: { connectionId: 'y', libraryId: 2 } },
        },
      ],
      activeProfileId: 'gone',
      askAtLaunch: true,
    });
    expect(parsed).toEqual({
      version: 1,
      profiles: [
        { id: 'a', name: 'Chris', connectionIds: ['x'], hasPin: true },
        {
          id: 'k',
          name: 'Leo',
          connectionIds: ['y'],
          kids: { bedtime: '19:30', library: { connectionId: 'y', libraryId: 2 } },
        },
      ],
      activeProfileId: 'a',
      askAtLaunch: true,
    });
  });
});

describe('reconcileProfiles', () => {
  it('returns the same document when nothing changes', () => {
    const d = doc({
      profiles: [{ id: 'p', name: 'chris', connectionIds: [A1.id, B1.id] }],
      activeProfileId: 'p',
    });
    expect(reconcileProfiles(d, [A1, B1], A1.id, ids)).toBe(d);
  });

  it('builds a missing document with initialProfiles (the migration rule)', () => {
    const next = reconcileProfiles(doc(), [A1, B1, A2], B1.id, ids);
    expect(next.profiles).toEqual([
      { id: 'p1', name: 'chris', connectionIds: [A1.id, B1.id] },
      { id: 'p2', name: 'sam', connectionIds: [A2.id] },
    ]);
    expect(next.activeProfileId).toBe('p1');
  });

  it('drops a removed connection and deletes a profile left empty', () => {
    const d = doc({
      profiles: [
        { id: 'p', name: 'chris', connectionIds: [A1.id, B1.id] },
        { id: 's', name: 'sam', connectionIds: [A2.id] },
      ],
      activeProfileId: 's',
    });
    const next = reconcileProfiles(d, [A1, B1], A1.id, ids);
    expect(next.profiles).toEqual([{ id: 'p', name: 'chris', connectionIds: [A1.id, B1.id] }]);
    // The active one went: the profile holding the default connection.
    expect(next.activeProfileId).toBe('p');
  });

  it('never keeps two connections of one server in a profile', () => {
    const d = doc({
      profiles: [{ id: 'p', name: 'chris', connectionIds: [A1.id, A2.id] }],
      activeProfileId: 'p',
    });
    const next = reconcileProfiles(d, [A1, A2], A1.id, ids);
    expect(next.profiles).toEqual([
      { id: 'p', name: 'chris', connectionIds: [A1.id] },
      { id: 'p1', name: 'sam', connectionIds: [A2.id] },
    ]);
    expect(next.activeProfileId).toBe('p');
  });

  it('places an unknown connection in the active profile, else one without its server, else its own', () => {
    const d = doc({
      profiles: [
        { id: 'p', name: 'chris', connectionIds: [A1.id] },
        { id: 's', name: 'sam', connectionIds: [C3.id] },
      ],
      activeProfileId: 'p',
    });
    expect(reconcileProfiles(d, [A1, C3, B1], A1.id, ids).profiles[0].connectionIds).toEqual([
      A1.id,
      B1.id,
    ]);
    // A2 can't join the active (srvA there already): the first profile without srvA.
    const next = reconcileProfiles(d, [A1, C3, A2], A1.id, ids);
    expect(next.profiles[1].connectionIds).toEqual([C3.id, A2.id]);
    expect(next.activeProfileId).toBe('p');
  });

  it('a second person appearing turns on asking at launch', () => {
    const d = doc({
      profiles: [{ id: 'p', name: 'chris', connectionIds: [A1.id] }],
      activeProfileId: 'p',
    });
    const next = reconcileProfiles(d, [A1, A2], A1.id, ids);
    expect(next.profiles).toHaveLength(2);
    expect(next.activeProfileId).toBe('p');
    expect(next.askAtLaunch).toBe(true);
  });

  it('with no connections, no profiles', () => {
    const d = doc({
      profiles: [{ id: 'p', name: 'chris', connectionIds: [A1.id] }],
      activeProfileId: 'p',
    });
    expect(reconcileProfiles(d, [], null, ids)).toEqual(doc({ profiles: [] }));
  });
});

describe('placeInDoc (the connect flow)', () => {
  const base = doc({
    profiles: [{ id: 'p', name: 'chris', connectionIds: [A1.id] }],
    activeProfileId: 'p',
  });

  it('joins the active profile when it has no connection to the server', () => {
    const { doc: next, profileId } = placeInDoc(base, B1, [A1, B1], {}, ids);
    expect(profileId).toBe('p');
    expect(next.profiles).toEqual([{ id: 'p', name: 'chris', connectionIds: [A1.id, B1.id] }]);
    expect(next.askAtLaunch).toBe(false);
  });

  it('another user on a server the active profile has: a new profile, made active', () => {
    const { doc: next, profileId } = placeInDoc(base, A2, [A1, A2], {}, ids);
    expect(profileId).toBe('p1');
    expect(next.profiles[1]).toEqual({ id: 'p1', name: 'sam', connectionIds: [A2.id] });
    expect(next.activeProfileId).toBe('p1');
    expect(next.askAtLaunch).toBe(true);
  });

  it('"Add someone": always a new profile, even on a new server', () => {
    const { doc: next } = placeInDoc(base, C3, [A1, C3], { newProfile: true }, ids);
    expect(next.profiles.map((p) => p.connectionIds)).toEqual([[A1.id], [C3.id]]);
    expect(next.activeProfileId).toBe('p1');
  });

  it('leaves a connection already in the active profile where it is', () => {
    const placed = reconcileProfiles(base, [A1, B1], A1.id, ids);
    expect(placeInDoc(placed, B1, [A1, B1], {}, ids)).toEqual({ doc: placed, profileId: 'p' });
  });

  it('moves a connection the reconcile placed a moment earlier', () => {
    const placed = reconcileProfiles(base, [A1, C3], A1.id, ids);
    expect(placed.profiles[0].connectionIds).toEqual([A1.id, C3.id]);
    const { doc: next } = placeInDoc(placed, C3, [A1, C3], { newProfile: true }, ids);
    expect(next.profiles.map((p) => p.connectionIds)).toEqual([[A1.id], [C3.id]]);
  });
});

describe('connectionsOfProfile', () => {
  it("keeps the session's order and falls back to every connection with no profile", () => {
    expect(connectionsOfProfile([A1, B1, C3], [C3.id, A1.id])).toEqual([A1, C3]);
    expect(connectionsOfProfile([A1, B1], null)).toEqual([A1, B1]);
  });
});

describe('the store', () => {
  it('adopts the document the migration wrote and keeps it as it was', async () => {
    const first = initialProfiles([A1, B1, A2], A1.id, ids);
    await AsyncStorage.setItem(PROFILES_KEY, JSON.stringify(first));
    setSession([A1, B1, A2], A1.id);
    await useProfiles.getState().hydrate();
    expect(useProfiles.getState().profiles).toEqual(first.profiles);
    expect(activeProfile()?.connectionIds).toEqual([A1.id, B1.id]);
    expect(JSON.parse((await AsyncStorage.getItem(PROFILES_KEY))!)).toEqual(first);
  });

  it('rebuilds a missing document once the session has loaded, and persists it', async () => {
    await useProfiles.getState().hydrate();
    // The session is still loading: nothing is decided from its empty list.
    expect(useProfiles.getState().profiles).toEqual([]);
    expect(await AsyncStorage.getItem(PROFILES_KEY)).toBeNull();
    await act(async () => setSession([A1, B1, A2], A1.id));
    expect(useProfiles.getState().profiles.map((p) => p.connectionIds)).toEqual([
      [A1.id, B1.id],
      [A2.id],
    ]);
    const stored = JSON.parse((await AsyncStorage.getItem(PROFILES_KEY))!) as ProfilesDoc;
    expect(stored.version).toBe(1);
    expect(stored.profiles).toHaveLength(2);
  });

  it('follows a removed connection (signing out) and deletes the empty profile', async () => {
    setSession([A1, A2], A1.id);
    await useProfiles.getState().hydrate();
    expect(useProfiles.getState().profiles).toHaveLength(2);
    await useSession.getState().removeConnection(A2.id);
    expect(useProfiles.getState().profiles.map((p) => p.connectionIds)).toEqual([[A1.id]]);
  });

  it('places a new connection with placeConnection', async () => {
    setSession([A1], A1.id);
    await useProfiles.getState().hydrate();
    setSession([A1, C3], A1.id);
    const placed = placeConnection(C3.id, { newProfile: true });
    expect(placed).toBe(activeProfile()?.id);
    expect(activeProfile()?.connectionIds).toEqual([C3.id]);
    expect(profileConnectionIds()).toEqual([C3.id]);
    expect(profileOf(A1.id)?.connectionIds).toEqual([A1.id]);
  });

  it('kids, PIN mirror, rename and ask-at-launch are persisted', async () => {
    setSession([A1, A2], A1.id);
    await useProfiles.getState().hydrate();
    const sam = profileOf(A2.id)!.id;
    setProfileKids(sam, { bedtime: '20:00', library: { connectionId: A2.id, libraryId: 3 } });
    setProfileHasPin(sam, true);
    renameProfile(sam, '  Sammy ');
    renameProfile(sam, '   ');
    setAskAtLaunch(false);
    const stored = JSON.parse((await AsyncStorage.getItem(PROFILES_KEY))!) as ProfilesDoc;
    expect(stored.profiles.find((p) => p.id === sam)).toEqual({
      id: sam,
      name: 'Sammy',
      connectionIds: [A2.id],
      kids: { bedtime: '20:00', library: { connectionId: A2.id, libraryId: 3 } },
      hasPin: true,
    });
    expect(stored.askAtLaunch).toBe(false);
    setProfileKids(sam, undefined);
    setProfileHasPin(sam, false);
    expect(profileOf(A2.id)).toEqual({ id: sam, name: 'Sammy', connectionIds: [A2.id] });
  });

  it('a bad bedtime falls back to the default', async () => {
    setSession([A1], A1.id);
    await useProfiles.getState().hydrate();
    setProfileKids(activeProfile()!.id, { bedtime: '25:99' });
    expect(activeProfile()?.kids).toEqual({ bedtime: '19:30' });
  });

  it('the hooks: the active profile and only its connections', async () => {
    setSession([A1, A2, B1], A1.id);
    await useProfiles.getState().hydrate();
    const { result } = await renderHook(() => ({
      profile: useActiveProfile(),
      connections: useProfileConnections(),
    }));
    expect(result.current.connections.map((c) => c.id)).toEqual([A1.id, B1.id]);
    const first = result.current.connections;
    const sam = profileOf(A2.id)!.id;
    await act(async () => {
      await switchProfile(sam);
    });
    expect(result.current.profile?.id).toBe(sam);
    expect(result.current.connections.map((c) => c.id)).toEqual([A2.id]);
    expect(result.current.connections).not.toBe(first);
  });
});

describe('switchProfile', () => {
  beforeEach(async () => {
    setSession([A1, B1, A2], A1.id);
    await useProfiles.getState().hydrate();
  });

  it("unloads another person's playing book (paused and saved by stop) and moves the default", async () => {
    mockPlayer.nowPlaying = { connectionId: B1.id };
    const sam = profileOf(A2.id)!.id;
    await switchProfile(sam);
    expect(activeProfile()?.id).toBe(sam);
    expect(mockPlayer.stop).toHaveBeenCalledTimes(1);
    expect(useSession.getState().defaultConnectionId).toBe(A2.id);
    const stored = JSON.parse((await AsyncStorage.getItem(PROFILES_KEY))!) as ProfilesDoc;
    expect(stored.activeProfileId).toBe(sam);
  });

  it("keeps a book of the new person's own servers playing", async () => {
    const sam = profileOf(A2.id)!.id;
    await switchProfile(sam);
    mockPlayer.nowPlaying = { connectionId: B1.id };
    await switchProfile(profileOf(A1.id)!.id);
    expect(mockPlayer.stop).not.toHaveBeenCalled();
    // The default was Sam's: it moves to Chris's first server, in session order.
    expect(useSession.getState().defaultConnectionId).toBe(A1.id);
  });

  it('keeps a default that is already one of the new profile', async () => {
    useSession.setState({ defaultConnectionId: B1.id });
    await switchProfile(profileOf(A1.id)!.id);
    expect(useSession.getState().defaultConnectionId).toBe(B1.id);
  });

  it('an unknown profile changes nothing', async () => {
    const before = activeProfile();
    await switchProfile('nobody');
    expect(activeProfile()).toBe(before);
  });

  it("a removal that leaves the default on someone else's server moves it back", async () => {
    // Chris is active (A1, B1); the session's own fallback after removing A1 is its first
    // remaining connection (B1), already Chris's: kept.
    await act(async () => {
      await useSession.getState().removeConnection(A1.id);
    });
    expect(useSession.getState().defaultConnectionId).toBe(B1.id);
    // Removing B1 too deletes Chris's profile: Sam becomes active, with his default.
    await act(async () => {
      await useSession.getState().removeConnection(B1.id);
    });
    expect(activeProfile()?.connectionIds).toEqual([A2.id]);
    expect(useSession.getState().defaultConnectionId).toBe(A2.id);
    // Chris left: Sam must be chosen (with his PIN), not assumed.
    expect(useProfiles.getState().chooseRequired).toBe(true);
    await switchProfile(activeProfile()!.id);
    expect(useProfiles.getState().chooseRequired).toBe(false);
  });

  it('removing someone who is not listening asks nobody to choose', async () => {
    await act(async () => {
      await useSession.getState().removeConnection(A2.id);
    });
    expect(useProfiles.getState().chooseRequired).toBe(false);
  });
});
