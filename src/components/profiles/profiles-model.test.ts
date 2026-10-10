import i18n from '@/i18n';
import type { Profile } from '@/stores/profiles';
import type { Connection } from '@/stores/session';

import {
  asksAtLaunch,
  otherOwner,
  profileName,
  profileStatus,
  resetLaunchDecisionForTests,
  serversLine,
  takeLaunchDecision,
  waitSeconds,
} from './profiles-model';

const t = i18n.t.bind(i18n);
const conn = (id: string, name: string, username: string) =>
  ({ id, name, user: { username } }) as Connection;
const conns = [
  conn('a.1', 'Hearthside', 'chris'),
  conn('b.1', "Maya's Shelf", 'chris'),
  conn('a.2', 'Hearthside', 'sam'),
];
const chris: Profile = { id: 'p', name: 'Chris', connectionIds: ['a.1', 'b.1'] };
const sam: Profile = { id: 's', name: '', connectionIds: ['a.2'] };

describe('profiles model', () => {
  it('names a profile by its own name, else its first server user', () => {
    expect(profileName(chris, conns, t)).toBe('Chris');
    expect(profileName(sam, conns, t)).toBe('sam');
    expect(profileName({ id: 'x', name: ' ', connectionIds: [] }, conns, t)).toBe('Someone');
  });

  it('lists servers in one line', () => {
    expect(serversLine(chris, conns, t)).toBe('Hearthside + 1 more');
    expect(serversLine(sam, conns, t)).toBe('Hearthside');
  });

  it('says kids mode, listening now, else the servers', () => {
    expect(profileStatus(chris, conns, true, t)).toBe('Listening now');
    expect(profileStatus(chris, conns, false, t)).toBe('Hearthside + 1 more');
    const leo: Profile = { ...sam, kids: { bedtime: '19:30' } };
    expect(profileStatus(leo, conns, true, t)).toBe('Kids mode · bedtime 19:30');
  });

  it('asks at launch only with two or more people and the setting on', () => {
    expect(asksAtLaunch({ askAtLaunch: true, profiles: [chris, sam] })).toBe(true);
    expect(asksAtLaunch({ askAtLaunch: false, profiles: [chris, sam] })).toBe(false);
    expect(asksAtLaunch({ askAtLaunch: true, profiles: [chris] })).toBe(false);
  });

  it("finds the other person a link's connection belongs to", () => {
    const doc = { profiles: [chris, sam], activeProfileId: 'p' };
    expect(otherOwner(doc, 'a.2')).toBe(sam);
    expect(otherOwner(doc, 'a.1')).toBeNull();
    expect(otherOwner(doc, 'gone')).toBeNull();
    expect(otherOwner(doc, '')).toBeNull();
    // Nobody chosen (the person listening left): a link to anyone's book meets the gate,
    // the PIN included.
    expect(otherOwner({ ...doc, activeProfileId: null }, 'a.1')?.id).toBe(doc.profiles[0].id);
  });

  it('rounds a wait up to whole seconds', () => {
    expect(waitSeconds(30_000)).toBe(30);
    expect(waitSeconds(29_001)).toBe(30);
    expect(waitSeconds(1)).toBe(1);
    expect(waitSeconds(0)).toBe(1);
  });

  it('decides about the launch picker once per runtime', () => {
    resetLaunchDecisionForTests();
    expect(takeLaunchDecision()).toBe(true);
    expect(takeLaunchDecision()).toBe(false);
  });
});
