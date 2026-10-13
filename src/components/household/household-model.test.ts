import { ApiError } from '@/api/client';
import type { HouseholdMember, HouseholdMembers } from '@/api/types';

import {
  addBlock,
  collectionIdsFor,
  collectionsMembers,
  confirmsName,
  defaultAccess,
  memberConnection,
  newAddForm,
  validMemberName,
  withAccess,
  withKid,
  writeError,
} from './household-model';

const member = (over: Partial<HouseholdMember> = {}): HouseholdMember => ({
  id: 12,
  name: 'Evie',
  username: 'evie',
  kind: 'kid',
  access: 'collections',
  created_at: '2026-10-13T10:00:00.000Z',
  collections: [],
  devices: 0,
  last_listened_at: null,
  ...over,
});
const list = (over: Partial<HouseholdMembers> = {}): HouseholdMembers => ({
  allowed: true,
  max: 2,
  members: [],
  ...over,
});

describe('validMemberName', () => {
  it('takes 1 to 40 characters once trimmed, counted as characters, not bytes', () => {
    expect(validMemberName('Evie')).toBe(true);
    expect(validMemberName('  Evie  ')).toBe(true);
    expect(validMemberName('x'.repeat(40))).toBe(true);
    expect(validMemberName('é'.repeat(40))).toBe(true);
    expect(validMemberName('👧'.repeat(40))).toBe(true);
  });

  it('refuses an empty, too long or control-character name', () => {
    expect(validMemberName('')).toBe(false);
    expect(validMemberName('   ')).toBe(false);
    expect(validMemberName('x'.repeat(41))).toBe(false);
    expect(validMemberName('Ev\nie')).toBe(false);
    expect(validMemberName('Ev\u0007ie')).toBe(false);
  });
});

describe('addBlock', () => {
  it('lets an allowed owner under the cap add', () => {
    expect(addBlock(list({ members: [member()] }))).toBeNull();
  });

  it("says the server's reason when adding is refused", () => {
    for (const reason of ['feature_off', 'not_allowed', 'member', 'demo'] as const) {
      expect(addBlock(list({ allowed: false, reason }))).toBe(reason);
    }
    // No reason given: the admin's switch is the likely one.
    expect(addBlock(list({ allowed: false }))).toBe('not_allowed');
  });

  it('is at the cap when the members fill it (the server sends no reason for that)', () => {
    expect(addBlock(list({ max: 1, members: [member()] }))).toBe('at_cap');
    expect(addBlock(list({ max: 1, members: [member(), member({ id: 13 })] }))).toBe('at_cap');
  });
});

describe('the add form (decision J)', () => {
  it('starts a kid on "Only collections I share" and a grown-up on "Everything"', () => {
    expect(defaultAccess(true)).toBe('collections');
    expect(defaultAccess(false)).toBe('all');
    expect(newAddForm()).toMatchObject({ kid: true, access: 'collections', accessPicked: false });
    expect(newAddForm(false)).toMatchObject({ kid: false, access: 'all' });
  });

  it('follows the Kids switch until the owner picks an access, then keeps it', () => {
    let f = newAddForm();
    f = withKid(f, false);
    expect(f.access).toBe('all');
    f = withKid(f, true);
    expect(f.access).toBe('collections');
    f = withAccess(f, 'all');
    f = withKid(f, false);
    f = withKid(f, true);
    expect(f.access).toBe('all');
  });

  it('sends the collections only for "Only collections I share"', () => {
    expect(collectionIdsFor('collections', [4, 5])).toEqual([4, 5]);
    expect(collectionIdsFor('collections', [])).toEqual([]);
    expect(collectionIdsFor('all', [4])).toBeUndefined();
  });
});

describe('writeError', () => {
  it('reads the cap, a refused name, a refusal and anything else', () => {
    expect(writeError(new ApiError(409, 'member_limit'))).toBe('limit');
    expect(writeError(new ApiError(400, 'invalid_name'))).toBe('invalid');
    expect(writeError(new ApiError(403, 'not_allowed'))).toBe('forbidden');
    expect(writeError(new ApiError(500, 'oops'))).toBe('failed');
    expect(writeError(new TypeError('Network request failed'))).toBe('failed');
  });
});

describe('memberConnection', () => {
  const conns = [
    { id: 'srv.1', serverId: 'srv', user: { id: 1 } },
    { id: 'srv.12', serverId: 'srv', user: { id: 12 } },
    { id: 'other.12', serverId: 'other', user: { id: 12 } },
  ];

  it("finds the member's connection on the owner's server, by server and user id", () => {
    expect(memberConnection(conns, conns[0], 12)?.id).toBe('srv.12');
    expect(memberConnection(conns, conns[0], 13)).toBeUndefined();
  });

  it('never takes the same user id on another server for them', () => {
    expect(memberConnection([conns[0], conns[2]], conns[0], 12)).toBeUndefined();
  });
});

describe('confirmsName', () => {
  it('matches the name ignoring case and outer spaces, never an empty one', () => {
    expect(confirmsName('evie', member())).toBe(true);
    expect(confirmsName('  EVIE ', member())).toBe(true);
    expect(confirmsName('Evi', member())).toBe(false);
    expect(confirmsName('', member({ name: '' }))).toBe(false);
  });
});

describe('collectionsMembers', () => {
  it('keeps only the members on "Only collections I share", by id', () => {
    const m = collectionsMembers(
      list({ members: [member(), member({ id: 13, name: 'Ellis', access: 'all' })] }),
    );
    expect([...m.keys()]).toEqual([12]);
    expect(collectionsMembers(undefined).size).toBe(0);
  });
});
