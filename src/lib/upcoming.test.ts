import type { Capabilities, UpcomingItem } from '@/api/types';
import { upcomingItem } from '@/testing/upcoming-fixtures';

import { compareUpcoming, isNewUpcoming, mergeUpcoming, upcomingEligibility } from './upcoming';

const NOW = new Date('2026-10-30T15:00:00Z');

describe('isNewUpcoming', () => {
  it('is new for seven days after the server first listed it', () => {
    expect(isNewUpcoming({ first_seen_at: '2026-10-30T04:00:00Z' }, NOW)).toBe(true);
    expect(isNewUpcoming({ first_seen_at: '2026-10-23T15:00:01Z' }, NOW)).toBe(true);
    expect(isNewUpcoming({ first_seen_at: '2026-10-23T15:00:00Z' }, NOW)).toBe(false);
    expect(isNewUpcoming({ first_seen_at: '2026-09-01T00:00:00Z' }, NOW)).toBe(false);
  });

  it('is not new without a readable time', () => {
    expect(isNewUpcoming({ first_seen_at: '' }, NOW)).toBe(false);
    expect(isNewUpcoming({ first_seen_at: 'yesterday' }, NOW)).toBe(false);
  });
});

describe('compareUpcoming', () => {
  const sorted = (items: UpcomingItem[]) => [...items].sort(compareUpcoming).map((i) => i.work.id);

  it('puts preorders (soonest first), then releases (newest first), then missing', () => {
    expect(
      sorted([
        upcomingItem({ id: 'm', kind: 'missing' }),
        upcomingItem({ id: 'r-old', kind: 'released', release_date: '2026-08-01' }),
        upcomingItem({ id: 'p-late', kind: 'preorder', release_date: '2027' }),
        upcomingItem({ id: 'r-new', kind: 'released', release_date: '2026-10' }),
        upcomingItem({ id: 'p-soon', kind: 'preorder', release_date: '2026-11-12' }),
      ]),
    ).toEqual(['p-soon', 'p-late', 'r-new', 'r-old', 'm']);
  });

  it('orders missing volumes by series name, then position as a number', () => {
    const missing = (id: string, name: string, position: string) =>
      upcomingItem({ id, series: { id: name.toLowerCase(), name, position } });
    expect(
      sorted([
        missing('b10', 'beta', '10'),
        missing('a3', 'Alpha', '3'),
        missing('b2', 'beta', '2.5'),
        missing('b9', 'beta', '9'),
      ]),
    ).toEqual(['a3', 'b2', 'b9', 'b10']);
  });

  it('shows an unknown kind with the missing volumes', () => {
    expect(
      sorted([
        upcomingItem({ id: 'x', kind: 'rumoured' }),
        upcomingItem({ id: 'p', kind: 'preorder', release_date: '2027' }),
      ]),
    ).toEqual(['p', 'x']);
  });
});

describe('mergeUpcoming', () => {
  it('tags each item, keeps the first connection row of a work and sorts across servers', () => {
    const merged = mergeUpcoming([
      {
        connectionId: 'a',
        connectionName: 'Home',
        items: [
          upcomingItem({ id: 'w1', kind: 'released', release_date: '2026-09-01' }),
          upcomingItem({ id: 'shared', kind: 'preorder', release_date: '2027-01' }),
        ],
      },
      {
        connectionId: 'b',
        connectionName: 'Maya',
        items: [
          upcomingItem({ id: 'shared', kind: 'preorder', release_date: '2027-01' }),
          upcomingItem({ id: 'w2', kind: 'preorder', release_date: '2026-11-12' }),
          upcomingItem({ id: 'w3', kind: 'released', release_date: '2026-10-20' }),
        ],
      },
    ]);
    expect(merged.map((i) => [i.work.id, i.connectionId])).toEqual([
      ['w2', 'b'],
      ['shared', 'a'],
      ['w3', 'b'],
      ['w1', 'a'],
    ]);
    expect(merged[1].connectionName).toBe('Home');
  });

  it('is empty for no answers', () => {
    expect(mergeUpcoming([])).toEqual([]);
  });
});

describe('upcomingEligibility', () => {
  const caps = (upcoming?: boolean) => ({ upcoming }) as unknown as Capabilities;
  const adult = { member_kind: undefined };
  const kid = { member_kind: 'kid' as const };

  it('asks only connections with the flag whose user is not a kid', () => {
    const r = upcomingEligibility(
      [
        { id: 'on', user: adult },
        { id: 'off', user: adult },
        { id: 'kid', user: kid },
      ],
      { on: caps(true), off: caps(false), kid: caps(true) },
    );
    expect([...r.eligible]).toEqual(['on']);
    expect(r.available).toBe(true);
  });

  it('is unavailable once every connection is known not to offer it', () => {
    const r = upcomingEligibility(
      [
        { id: 'old', user: adult },
        { id: 'kid', user: kid },
      ],
      { old: caps(undefined) },
    );
    expect(r.eligible.size).toBe(0);
    expect(r.available).toBe(false);
  });

  it('settles on a server whose flags could not be read (unreadable, not loading)', () => {
    const r = upcomingEligibility(
      [
        { id: 'down', user: adult },
        { id: 'kid', user: kid },
      ],
      {},
      ['down', 'kid'],
    );
    expect(r.available).toBe(false);
    // A kid's connection is never asked, so it is not counted as unreadable.
    expect(r.unreadable).toEqual(new Set(['down']));
    // Another server still loading keeps it open; one with the flag makes it available.
    const mixed = [
      { id: 'down', user: adult },
      { id: 'b', user: adult },
    ];
    expect(upcomingEligibility(mixed, {}, ['down']).available).toBeUndefined();
    const withB = upcomingEligibility(mixed, { b: caps(true) }, ['down']);
    expect(withB.available).toBe(true);
    expect(withB.unreadable).toEqual(new Set(['down']));
  });

  it("is not known while a server's flags are still loading", () => {
    const r = upcomingEligibility([{ id: 'a', user: adult }], {});
    expect(r.available).toBeUndefined();
    // A kid's connection is known at once: nothing to wait for.
    expect(upcomingEligibility([{ id: 'k', user: kid }], {}).available).toBe(false);
  });
});
