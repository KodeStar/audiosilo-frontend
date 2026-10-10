import i18n from '@/i18n';
import type { Profile } from '@/stores/profiles';
import type { Connection } from '@/stores/session';

import {
  asksAtLaunch,
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
  it('names a profile by its name (the store fills it), else a neutral word', () => {
    expect(profileName(chris, t)).toBe('Chris');
    expect(profileName({ ...chris, name: ' Chris ' }, t)).toBe('Chris');
    expect(profileName({ id: 'x', name: ' ', connectionIds: [] }, t)).toBe('Someone');
  });

  it('lists servers in one line', () => {
    expect(serversLine(chris, conns, t)).toBe('Hearthside + 1 more');
    expect(serversLine(sam, conns, t)).toBe('Hearthside');
  });

  it('says kids mode, listening now, else the servers', () => {
    expect(profileStatus(chris, conns, true, t)).toBe('Listening now');
    expect(profileStatus(chris, conns, false, t)).toBe('Hearthside + 1 more');
    const leo: Profile = { ...sam, kids: { bedtime: '19:30' } };
    // The reader's clock (12 h here), as the kids card and the Household row show it.
    expect(profileStatus(leo, conns, true, t)).toBe('Kids mode · bedtime 7:30 PM');
  });

  it('asks at launch only with two or more people and the setting on', () => {
    expect(asksAtLaunch({ askAtLaunch: true, profiles: [chris, sam] })).toBe(true);
    expect(asksAtLaunch({ askAtLaunch: false, profiles: [chris, sam] })).toBe(false);
    expect(asksAtLaunch({ askAtLaunch: true, profiles: [chris] })).toBe(false);
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
