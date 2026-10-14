import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AuthSession, User } from '@/api/types';
import { setConnectForNewProfile } from '@/components/profiles/connect-intent';
import {
  activeProfile,
  DEFAULT_BEDTIME,
  profileOf,
  resetProfilesForTests,
  setProfileKids,
  useProfiles,
} from '@/stores/profiles';
import { useSession } from '@/stores/session';

import {
  addMemberHere,
  AddMemberHereError,
  memberOwnerHere,
  memberSignedInHere,
  renewMemberHere,
} from './add-member-here';
import { finishConnect } from './finish-connect';

// The owner's book must play on: a switch of person would stop it.
const mockStop = jest.fn(async () => undefined);
jest.mock('@/playback/store', () => ({
  usePlayer: {
    getState: () => ({ nowPlaying: { connectionId: 'srv.1' }, stop: mockStop }),
  },
}));

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), dismissTo: jest.fn() },
}));

const adam: User = {
  id: 1,
  username: 'adam',
  role: 'user',
  disabled: false,
  has_password: true,
  has_recovery: false,
  managed_by: null,
  member_kind: null,
};
const evie: User = {
  ...adam,
  id: 12,
  username: 'evie',
  has_password: false,
  managed_by: { id: 1, username: 'adam' },
  member_kind: 'kid',
};
const ellis: User = { ...evie, id: 13, username: 'ellis', member_kind: 'grownup' };

const HOME = 'http://192.168.1.20:8080';
const AWAY = 'https://books.example.com';

const memberSession = (u: User, extra: Partial<AuthSession> = {}): AuthSession => ({
  token: `tok-${u.username}`,
  server_id: 'srv',
  user: u,
  ...extra,
});

const people = () => useProfiles.getState().profiles.map((p) => [p.name, p.connectionIds]);

beforeEach(async () => {
  await AsyncStorage.clear();
  mockStop.mockClear();
  resetProfilesForTests();
  setConnectForNewProfile(false);
  useSession.setState({
    status: 'unauthenticated',
    connections: [],
    defaultConnectionId: null,
    pendingServerUrl: null,
    user: null,
  });
  await useProfiles.getState().hydrate();
  // Adam, signed in at home and listening.
  await finishConnect({
    serverUrl: HOME,
    session: { token: 'tok-adam', server_id: 'srv', user: adam },
    name: 'Hearthside',
  });
});

it('signs a kid in beside the owner: a new profile in kids mode, the owner still listening', async () => {
  const owner = activeProfile()!.id;
  const { connectionId, profileId } = await addMemberHere(memberSession(evie), { name: 'Evie' });
  expect(connectionId).toBe('srv.12');
  // The owner stays active, the default connection unchanged, no switch (nothing stopped).
  expect(activeProfile()?.id).toBe(owner);
  expect(useSession.getState().defaultConnectionId).toBe('srv.1');
  expect(mockStop).not.toHaveBeenCalled();
  // The member's profile: named as typed, in kids mode, holding only their connection.
  expect(profileOf(connectionId)).toEqual({
    id: profileId,
    name: 'Evie',
    connectionIds: ['srv.12'],
    kids: { bedtime: DEFAULT_BEDTIME },
  });
  expect(people()).toEqual([
    ['adam', ['srv.1']],
    ['Evie', ['srv.12']],
  ]);
  // Stored on the owner's address, under the server's name, with the member's own token.
  expect(useSession.getState().connections[1]).toMatchObject({
    id: 'srv.12',
    serverUrl: HOME,
    name: 'Hearthside',
    token: 'tok-evie',
    user: evie,
  });
  // A second person on the device: asked at launch from now on (Phase 8's rule).
  expect(useProfiles.getState().askAtLaunch).toBe(true);
});

it("signs a grown-up in with kids mode off (the server's member_kind decides)", async () => {
  const { profileId } = await addMemberHere(memberSession(ellis), { name: 'Ellis' });
  const profile = useProfiles.getState().profiles.find((p) => p.id === profileId);
  expect(profile?.name).toBe('Ellis');
  expect(profile?.kids).toBeUndefined();
  expect(activeProfile()?.name).toBe('adam');
});

it('learns the addresses the answer carried, on both connections', async () => {
  await addMemberHere(memberSession(evie, { addresses: { home: HOME, away: AWAY } }), {
    name: 'Evie',
  });
  for (const c of useSession.getState().connections) {
    expect(c.addresses).toEqual({ home: HOME, away: AWAY });
  }
});

it('refuses a member already signed in on this device, changing nothing', async () => {
  await addMemberHere(memberSession(evie), { name: 'Evie' });
  const connections = useSession.getState().connections;
  const doc = useProfiles.getState().profiles;
  expect(memberSignedInHere('srv', 12)).toBe(true);
  expect(memberSignedInHere('srv', 13)).toBe(false);
  expect(memberSignedInHere('other', 12)).toBe(false);
  const failed = addMemberHere(memberSession(evie, { token: 'again' }), { name: 'Evie' });
  await expect(failed).rejects.toBeInstanceOf(AddMemberHereError);
  await expect(failed).rejects.toMatchObject({ code: 'already_here' });
  expect(useSession.getState().connections).toBe(connections);
  expect(useProfiles.getState().profiles).toBe(doc);
});

it('refuses the owner signing themselves in again as a member', async () => {
  await expect(addMemberHere(memberSession(adam), { name: 'Adam' })).rejects.toMatchObject({
    code: 'already_here',
  });
});

it('refuses while a kids profile is listening with a grown-up on the device', async () => {
  const { profileId } = await addMemberHere(memberSession(evie), { name: 'Evie' });
  useProfiles.setState({ activeProfileId: profileId });
  await expect(addMemberHere(memberSession(ellis), { name: 'Ellis' })).rejects.toMatchObject({
    code: 'choose_adult',
  });
  expect(useSession.getState().connections.map((c) => c.id)).toEqual(['srv.1', 'srv.12']);
  setProfileKids(profileId, undefined);
});

it('refuses while the profiles are not read, and with no connection to that server', async () => {
  await expect(
    addMemberHere({ ...memberSession(evie), server_id: 'elsewhere' }, { name: 'Evie' }),
  ).rejects.toMatchObject({ code: 'not_ready' });
  resetProfilesForTests();
  await expect(addMemberHere(memberSession(evie), { name: 'Evie' })).rejects.toMatchObject({
    code: 'not_ready',
  });
  expect(useSession.getState().connections.map((c) => c.id)).toEqual(['srv.1']);
});

describe('signing a member this device holds in again (8b-1, D1)', () => {
  it('renews only the token: same connection, person, kids mode; the owner keeps listening', async () => {
    const { profileId } = await addMemberHere(memberSession(evie), { name: 'Evie' });
    await useSession.getState().markNeedsReconnect('srv.12', 'auth');
    const before = profileOf('srv.12');
    const id = await renewMemberHere(memberSession(evie, { token: 'fresh' }));
    expect(id).toBe('srv.12');
    const renewed = useSession.getState().connections.find((c) => c.id === 'srv.12');
    expect(renewed).toMatchObject({ token: 'fresh', serverUrl: HOME, name: 'Hearthside' });
    expect(renewed?.needsReconnect).toBeUndefined();
    expect(profileOf('srv.12')).toEqual(before);
    expect(profileOf('srv.12')?.id).toBe(profileId);
    expect(activeProfile()?.name).toBe('adam');
    expect(useSession.getState().defaultConnectionId).toBe('srv.1');
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('refuses a member this device does not hold, changing nothing', async () => {
    const connections = useSession.getState().connections;
    await expect(renewMemberHere(memberSession(evie))).rejects.toMatchObject({ code: 'not_ready' });
    expect(useSession.getState().connections).toBe(connections);
  });

  it("finds the member's owner among the person listening's connections, and only theirs", async () => {
    await addMemberHere(memberSession(evie), { name: 'Evie' });
    const kid = useSession.getState().connections.find((c) => c.id === 'srv.12')!;
    const all = () => useSession.getState().connections;
    expect(memberOwnerHere(kid, all())?.id).toBe('srv.1');
    // Someone else listening: not theirs to renew.
    const evieProfile = profileOf('srv.12')!.id;
    useProfiles.setState({ activeProfileId: evieProfile });
    expect(memberOwnerHere(kid, all())).toBeNull();
    // An ordinary account has no owner.
    const owner = useSession.getState().connections.find((c) => c.id === 'srv.1')!;
    expect(memberOwnerHere(owner, all())).toBeNull();
  });
});
