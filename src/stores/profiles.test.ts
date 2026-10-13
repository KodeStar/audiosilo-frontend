import AsyncStorage from '@react-native-async-storage/async-storage';

import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';

import type { User } from '@/api/types';
import { initialProfiles } from '@/lib/identity-migration';
import { PROFILES_KEY } from '@/lib/storage-keys';
import {
  activeProfile,
  askOnSecondPerson,
  connectionsOfProfile,
  deleteProfile,
  HYDRATE_ATTEMPTS,
  HYDRATE_RETRY_MS,
  mayActFor,
  mayTurnOnKids,
  mustChoose,
  otherOwner,
  parseProfilesDoc,
  placeConnection,
  placeInDoc,
  profileConnectionIds,
  profileOf,
  type ProfilesDoc,
  reconcileProfiles,
  renameProfile,
  replaceInDoc,
  resetProfilesForTests,
  setAskAtLaunch,
  setProfileHasPin,
  setProfileKids,
  staleToRetire,
  switchProfile,
  useActiveProfile,
  useProfileConnections,
  useProfiles,
  visibleConnectionIds,
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

  it('drops broken profiles and duplicate ids; an unknown active id is nobody; keeps kids + hasPin', () => {
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
      // Never the first person by default: they may have a PIN (`mustChoose`).
      activeProfileId: null,
      askAtLaunch: true,
    });
  });

  it('keeps nobody active across a reload (someone must be chosen)', () => {
    const stored = doc({
      profiles: [
        { id: 'a', name: 'Alex', connectionIds: ['x.1'], hasPin: true },
        { id: 's', name: 'Sam', connectionIds: ['y.2'] },
      ],
      activeProfileId: null,
    });
    const parsed = parseProfilesDoc(JSON.parse(JSON.stringify(stored)));
    expect(parsed.activeProfileId).toBeNull();
    expect(mustChoose(parsed)).toBe(true);
    expect(visibleConnectionIds(parsed)).toEqual([]);
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
    // The active one went: nobody, until someone is chosen (with their PIN), never the
    // profile holding the default connection.
    expect(next.activeProfileId).toBeNull();
    expect(mustChoose(next)).toBe(true);
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
    const next = askOnSecondPerson(d, reconcileProfiles(d, [A1, A2], A1.id, ids));
    expect(next.profiles).toHaveLength(2);
    expect(next.activeProfileId).toBe('p');
    expect(next.askAtLaunch).toBe(true);
  });

  it('names a profile with no name after its first connection, keeping any name it has', () => {
    const d = doc({
      profiles: [
        { id: 'p', name: '', connectionIds: [B1.id, A1.id] },
        { id: 's', name: ' Sammy ', connectionIds: [A2.id] },
      ],
      activeProfileId: 'p',
    });
    const next = reconcileProfiles(d, [A1, A2, B1], A1.id, ids);
    // The first in the session's order (A1, chris), and a name trimmed.
    expect(next.profiles.map((p) => p.name)).toEqual(['chris', 'Sammy']);
    // No username known yet: still empty (the screen says "Someone"), filled once it is.
    const nameless = { ...A1, user: { ...A1.user, username: '' } };
    const blank = doc({
      profiles: [{ id: 'p', name: '', connectionIds: [A1.id] }],
      activeProfileId: 'p',
    });
    expect(reconcileProfiles(blank, [nameless], A1.id, ids)).toBe(blank);
    expect(reconcileProfiles(blank, [A1], A1.id, ids).profiles[0].name).toBe('chris');
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
    const { doc: placed, profileId } = placeInDoc(base, B1, [A1, B1], {}, ids);
    const next = askOnSecondPerson(base, placed);
    expect(profileId).toBe('p');
    expect(next.profiles).toEqual([{ id: 'p', name: 'chris', connectionIds: [A1.id, B1.id] }]);
    expect(next.askAtLaunch).toBe(false);
  });

  it('another user on a server the active profile has: a new profile, made active', () => {
    const { doc: placed, profileId } = placeInDoc(base, A2, [A1, A2], {}, ids);
    const next = askOnSecondPerson(base, placed);
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

  it('visibleConnectionIds: the active profile, none while nobody is chosen, all with no profiles', () => {
    const p = { id: 'p', name: 'chris', connectionIds: [A1.id] };
    expect(visibleConnectionIds(doc({ profiles: [p], activeProfileId: 'p' }))).toEqual([A1.id]);
    expect(visibleConnectionIds(doc({ profiles: [p], activeProfileId: null }))).toEqual([]);
    expect(visibleConnectionIds(doc())).toBeNull();
    expect(connectionsOfProfile([A1, B1], visibleConnectionIds(doc({ profiles: [p] })))).toEqual(
      [],
    );
  });
});

describe('otherOwner / mayActFor', () => {
  const chris = { id: 'p', name: 'Chris', connectionIds: ['a.1'] };
  const sam = { id: 's', name: 'Sam', connectionIds: ['a.2'] };
  const both = { profiles: [chris, sam], activeProfileId: 'p' };

  it("finds the other person a link's connection belongs to", () => {
    expect(otherOwner(both, 'a.2')).toBe(sam);
    expect(otherOwner(both, 'a.1')).toBeNull();
    expect(otherOwner(both, 'gone')).toBeNull();
    expect(otherOwner(both, '')).toBeNull();
    // Nobody chosen (the person listening left): a link to anyone's book meets the gate,
    // the PIN included.
    expect(otherOwner({ ...both, activeProfileId: null }, 'a.1')).toBe(chris);
  });

  it("only the person listening's books may play; a connection nobody holds may", () => {
    expect(mayActFor('a.1', both)).toBe(true);
    expect(mayActFor('a.2', both)).toBe(false);
    expect(mayActFor('a.1', { ...both, activeProfileId: null })).toBe(false);
    // Not read yet, or no profiles at all (as before profiles): not refused.
    expect(mayActFor('elsewhere.1', both)).toBe(true);
    expect(mayActFor('a.2', { profiles: [], activeProfileId: null })).toBe(true);
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

  it('finding 4: retries a failed read without replacing PIN or kids protections', async () => {
    const doc = {
      version: 1,
      profiles: [
        {
          id: 'protected',
          name: 'Child',
          connectionIds: [A1.id],
          hasPin: true,
          kids: { bedtime: '20:00' },
        },
      ],
      activeProfileId: 'protected',
      askAtLaunch: false,
    };
    await AsyncStorage.setItem(PROFILES_KEY, JSON.stringify(doc));
    setSession([A1], A1.id);
    const read = AsyncStorage.getItem as jest.Mock;
    const original = read.getMockImplementation()!;
    read.mockRejectedValueOnce(new Error('io'));
    jest.useFakeTimers();
    try {
      const run = useProfiles.getState().hydrate();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(useProfiles.getState().hydrated).toBe(false);
      expect(mayActFor(A1.id)).toBe(false);
      expect(profileConnectionIds()).toEqual([]);
      expect(await AsyncStorage.getItem(PROFILES_KEY)).toBe(JSON.stringify(doc));
      await jest.advanceTimersByTimeAsync(1000);
      await run;
      expect(useProfiles.getState().profiles).toEqual(doc.profiles);
      expect(await AsyncStorage.getItem(PROFILES_KEY)).toBe(JSON.stringify(doc));
    } finally {
      read.mockImplementation(original);
      jest.useRealTimers();
    }
  });

  describe('finding 5: a document that never reads (web storage blocked)', () => {
    let read: jest.Mock;
    let original: (key: string) => Promise<string | null>;
    beforeEach(() => {
      read = AsyncStorage.getItem as jest.Mock;
      original = read.getMockImplementation()!;
      read.mockImplementation((key: string) =>
        key === PROFILES_KEY ? Promise.reject(new Error('SecurityError')) : original(key),
      );
      read.mockClear();
      jest.useFakeTimers();
    });
    afterEach(() => {
      read.mockImplementation(original);
      jest.useRealTimers();
    });

    /** Hydrate through every attempt; resolves (the launch steps go on). */
    async function hydrateGivingUp() {
      const run = useProfiles.getState().hydrate();
      await jest.advanceTimersByTimeAsync(HYDRATE_ATTEMPTS * HYDRATE_RETRY_MS);
      await run;
    }

    it('with nobody signed in, stops waiting and lets someone sign in, in memory only', async () => {
      setSession([]);
      const write = AsyncStorage.setItem as jest.Mock;
      write.mockClear();
      await hydrateGivingUp();
      expect(read.mock.calls.filter(([k]) => k === PROFILES_KEY)).toHaveLength(HYDRATE_ATTEMPTS);
      expect(useProfiles.getState()).toMatchObject({
        hydrated: true,
        hydrationFailed: false,
        unread: true,
      });
      // A sign-in (the connect flow): that person gets a profile and their book plays.
      setSession([A1], A1.id);
      expect(placeConnection(A1.id)).not.toBeNull();
      expect(mayActFor(A1.id)).toBe(true);
      expect(profileConnectionIds()).toEqual([A1.id]);
      // A connection this run did not see signed in (the session's list read later) is
      // nobody's here: never shown, never played (its person may have a PIN).
      await act(async () => setSession([A1, B1], A1.id));
      expect(profileOf(B1.id)).toBeNull();
      expect(mayActFor(B1.id)).toBe(false);
      expect(profileConnectionIds()).toEqual([A1.id]);
      // The document it never read is never written over.
      expect(write.mock.calls.filter(([k]) => k === PROFILES_KEY)).toHaveLength(0);
    });

    it('with someone signed in, stops waiting but stays shut, and reads again in the front', async () => {
      const stored = {
        version: 1,
        profiles: [{ id: 'kid', name: 'Kid', connectionIds: [A1.id], kids: { bedtime: '19:30' } }],
        activeProfileId: 'kid',
        askAtLaunch: false,
      };
      await AsyncStorage.setItem(PROFILES_KEY, JSON.stringify(stored));
      setSession([A1], A1.id);
      let onAppState: ((s: string) => void) | null = null;
      const listen = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
        _t: string,
        h: (s: string) => void,
      ) => {
        onAppState = h;
        return { remove: () => (onAppState = null) };
      }) as unknown as typeof AppState.addEventListener);
      try {
        await hydrateGivingUp();
        expect(useProfiles.getState().hydrationFailed).toBe(true);
        expect(mayActFor(A1.id)).toBe(false);
        expect(profileConnectionIds()).toEqual([]);
        // Storage answers again; the app comes to the front.
        read.mockImplementation(original);
        await act(async () => onAppState?.('active'));
        expect(useProfiles.getState().profiles).toEqual(stored.profiles);
        expect(useProfiles.getState().hydrationFailed).toBe(false);
        expect(onAppState).toBeNull();
      } finally {
        listen.mockRestore();
      }
    });
  });

  it("a failed read of the session's connections never reads as everyone signed out", async () => {
    // A parent with a PIN and a child in kids mode; the connections list can't be read
    // this launch (a storage error the session's own read used to swallow as "none").
    const stored = {
      version: 1,
      profiles: [
        { id: 'parent', name: 'Parent', connectionIds: [A1.id], hasPin: true },
        { id: 'kid', name: 'Kid', connectionIds: [A2.id], kids: { bedtime: '19:30' } },
      ],
      activeProfileId: 'kid',
      askAtLaunch: true,
    };
    await AsyncStorage.setItem(PROFILES_KEY, JSON.stringify(stored));
    const read = AsyncStorage.getItem as jest.Mock;
    const original = read.getMockImplementation()!;
    read.mockImplementation((key: string) =>
      key === 'audiosilo.connections' ? Promise.reject(new Error('io')) : original(key),
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await Promise.all([useSession.getState().hydrate(), useProfiles.getState().hydrate()]);
      expect(useProfiles.getState().profiles).toEqual(stored.profiles);
      expect(JSON.parse((await AsyncStorage.getItem(PROFILES_KEY))!)).toEqual(stored);
    } finally {
      read.mockImplementation(original);
      warn.mockRestore();
      // A read that works ends the failed hydrate for the tests after this one.
      await useSession.getState().hydrate();
    }
  });

  it('a document that reads but does not parse counts as missing (no endless wait)', async () => {
    await AsyncStorage.setItem(PROFILES_KEY, '{not json');
    setSession([A1], A1.id);
    await useProfiles.getState().hydrate();
    expect(useProfiles.getState().hydrated).toBe(true);
    expect(useProfiles.getState().profiles.map((p) => p.connectionIds)).toEqual([[A1.id]]);
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

  it('asks at launch once a second person appears, whichever way they came', async () => {
    setSession([A1], A1.id);
    await useProfiles.getState().hydrate();
    expect(useProfiles.getState().askAtLaunch).toBe(false);
    // The reconcile gives another user of the same server a profile of their own.
    await act(async () => setSession([A1, A2], A1.id));
    expect(useProfiles.getState().profiles).toHaveLength(2);
    expect(useProfiles.getState().askAtLaunch).toBe(true);
    // Turned off by the listener: a third person does not turn it back on.
    setAskAtLaunch(false);
    await act(async () => setSession([A1, A2, C3], A1.id));
    placeConnection(C3.id, { newProfile: true });
    expect(useProfiles.getState().profiles).toHaveLength(3);
    expect(useProfiles.getState().askAtLaunch).toBe(false);
  });

  it('the connect flow adding a second person asks at launch', async () => {
    setSession([A1], A1.id);
    await useProfiles.getState().hydrate();
    await act(async () => setSession([A1, C3], A1.id));
    expect(useProfiles.getState().askAtLaunch).toBe(false);
    placeConnection(C3.id, { newProfile: true });
    expect(useProfiles.getState().askAtLaunch).toBe(true);
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
    setSession([A1, A2], A1.id);
    await useProfiles.getState().hydrate();
    const sam = profileOf(A2.id)!.id;
    setProfileKids(sam, { bedtime: '25:99' });
    expect(profileOf(A2.id)?.kids).toEqual({ bedtime: '19:30' });
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
    // Removing B1 too deletes Chris's profile: nobody is active (Sam must be chosen, with
    // his PIN, not assumed), persisted, and nobody's connections show.
    await act(async () => {
      await useSession.getState().removeConnection(B1.id);
    });
    expect(activeProfile()).toBeNull();
    expect(mustChoose(useProfiles.getState())).toBe(true);
    expect(profileConnectionIds()).toEqual([]);
    const stored = JSON.parse((await AsyncStorage.getItem(PROFILES_KEY))!) as ProfilesDoc;
    expect(stored.activeProfileId).toBeNull();
    await switchProfile(profileOf(A2.id)!.id);
    expect(mustChoose(useProfiles.getState())).toBe(false);
    expect(useSession.getState().defaultConnectionId).toBe(A2.id);
  });

  it('removing someone who is not listening asks nobody to choose', async () => {
    await act(async () => {
      await useSession.getState().removeConnection(A2.id);
    });
    expect(mustChoose(useProfiles.getState())).toBe(false);
    expect(activeProfile()?.connectionIds).toEqual([A1.id, B1.id]);
  });

  it('removing the active person (deleteProfile) leaves nobody active, across a reload', async () => {
    const sam = profileOf(A2.id)!;
    await switchProfile(sam.id);
    // "Remove from this device": their connection signed out, then the profile deleted.
    await act(async () => {
      await useSession.getState().removeConnection(A2.id);
    });
    deleteProfile(sam.id);
    expect(mustChoose(useProfiles.getState())).toBe(true);
    // A cold start reads the same: nobody, so "Who's listening?" asks (Chris's PIN).
    resetProfilesForTests();
    await useProfiles.getState().hydrate();
    expect(activeProfile()).toBeNull();
    expect(mustChoose(useProfiles.getState())).toBe(true);
    expect(profileConnectionIds()).toEqual([]);
  });

  it('deleting a profile that is not active keeps the active one', async () => {
    const sam = profileOf(A2.id)!.id;
    deleteProfile(sam);
    expect(activeProfile()?.connectionIds).toEqual([A1.id, B1.id]);
  });

  it('a sign-in while nobody is chosen is a new person, made active; a re-pair is nobody', async () => {
    await act(async () => {
      await useSession.getState().removeConnection(A1.id);
      await useSession.getState().removeConnection(B1.id);
    });
    expect(mustChoose(useProfiles.getState())).toBe(true);
    // A re-pair of Sam's connection (already his) places nothing and switches nobody.
    expect(profileOf(A2.id)).not.toBeNull();
    // A new account signed in: a profile of its own (they just proved who they are).
    setSession([A2, C3], A2.id);
    const placed = placeConnection(C3.id);
    expect(activeProfile()?.id).toBe(placed);
    expect(activeProfile()?.connectionIds).toEqual([C3.id]);
    expect(profileOf(A2.id)?.id).not.toBe(placed);
  });
});

describe('staleToRetire (a sign-in to a server that was reset)', () => {
  const doc = {
    hydrated: true,
    hydrationFailed: false,
    activeProfileId: 'a',
    profiles: [
      { id: 'a', name: 'Alex', connectionIds: ['old.1', 'x.1'] },
      { id: 'b', name: 'Bea', connectionIds: ['old.2'] },
    ],
  };

  it("retires the signer's own: the reconnect's person, else the person listening", () => {
    expect(staleToRetire(['old.1', 'old.2'], doc)).toEqual(['old.1']);
    expect(staleToRetire(['old.1', 'old.2'], doc, { reconnectId: 'old.2' })).toEqual(['old.2']);
  });

  it('retires nobody for a new person, nobody chosen, or profiles not read', () => {
    expect(staleToRetire(['old.1'], doc, { newPerson: true })).toEqual([]);
    expect(staleToRetire(['old.1'], { ...doc, activeProfileId: null })).toEqual([]);
    expect(staleToRetire(['old.1'], { ...doc, hydrated: false })).toEqual([]);
    expect(staleToRetire(['old.1'], { ...doc, hydrationFailed: true })).toEqual([]);
  });

  it('retires every one with nobody on the device', () => {
    expect(staleToRetire(['old.1', 'old.2'], { ...doc, profiles: [] })).toEqual(['old.1', 'old.2']);
  });
});

describe('replaceInDoc', () => {
  it("puts the new id in the old one's place, keeping the person, and moves a kids pick", () => {
    const doc: ProfilesDoc = {
      version: 1,
      activeProfileId: 'k',
      askAtLaunch: true,
      profiles: [
        { id: 'g', name: 'Gran', connectionIds: ['old.1', 'new.9'] },
        {
          id: 'k',
          name: 'Leo',
          connectionIds: ['x.4', 'old.2'],
          hasPin: true,
          kids: { library: { connectionId: 'old.2', libraryId: 5 }, bedtime: '19:00' },
        },
      ],
    };
    expect(replaceInDoc(doc, 'old.2', 'new.9').profiles).toEqual([
      { id: 'g', name: 'Gran', connectionIds: ['old.1'] },
      {
        id: 'k',
        name: 'Leo',
        connectionIds: ['x.4', 'new.9'],
        hasPin: true,
        kids: { library: { connectionId: 'new.9', libraryId: 5 }, bedtime: '19:00' },
      },
    ]);
    expect(replaceInDoc(doc, 'nobody', 'new.9')).toBe(doc);
  });
});

describe('kids mode keeps a grown-up on the device', () => {
  beforeEach(() => {
    useProfiles.setState({
      hydrated: true,
      activeProfileId: 'g',
      profiles: [
        { id: 'g', name: 'Gran', connectionIds: ['a.1'] },
        { id: 'k', name: 'Leo', connectionIds: ['a.2'] },
      ],
    });
  });
  afterEach(() => resetProfilesForTests());

  it('refuses kids mode for the last grown-up; a kids profile still changes its settings', () => {
    setProfileKids('k', { bedtime: '19:00' });
    expect(mayTurnOnKids('g')).toBe(false);
    setProfileKids('g', { bedtime: '19:00' });
    expect(useProfiles.getState().profiles.find((p) => p.id === 'g')?.kids).toBeUndefined();
    setProfileKids('k', { bedtime: '20:00' });
    expect(useProfiles.getState().profiles.find((p) => p.id === 'k')?.kids?.bedtime).toBe('20:00');
    // Off is always allowed.
    setProfileKids('k', undefined);
    expect(mayTurnOnKids('g')).toBe(true);
    // A lone profile is the last grown-up too.
    expect(mayTurnOnKids('g', { profiles: [{ id: 'g', name: 'Gran', connectionIds: [] }] })).toBe(
      false,
    );
  });
});
