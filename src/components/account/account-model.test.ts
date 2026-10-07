import type { MyDevice } from '@/api/types';

import {
  ACTIVE_NOW_MS,
  avatarHues,
  canRevoke,
  deviceGlyph,
  formatCountdown,
  knownPlatform,
  lastSeen,
  PAIRING_TTL_MS,
  pairingSecondsLeft,
  resolveAccountCid,
  signedInSessions,
} from './account-model';

const device = (over: Partial<MyDevice>): MyDevice => ({
  id: 1,
  kind: 'session',
  name: 'Phone',
  client: null,
  created_at: '2026-10-01T10:00:00Z',
  last_seen: null,
  last_ip: '',
  current: false,
  ...over,
});

const NOW = Date.parse('2026-10-08T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('pairing countdown', () => {
  it('counts whole seconds down to 0 and never below', () => {
    const expiresAt = NOW + PAIRING_TTL_MS;
    expect(pairingSecondsLeft(expiresAt, NOW)).toBe(600);
    // Rounded up: the last part-second still reads 0:01.
    expect(pairingSecondsLeft(expiresAt, expiresAt - 200)).toBe(1);
    expect(pairingSecondsLeft(expiresAt, expiresAt)).toBe(0);
    expect(pairingSecondsLeft(expiresAt, expiresAt + 5000)).toBe(0);
  });

  it('formats m:ss', () => {
    expect(formatCountdown(600)).toBe('10:00');
    expect(formatCountdown(545)).toBe('9:05');
    expect(formatCountdown(42)).toBe('0:42');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-3)).toBe('0:00');
  });
});

describe('resolveAccountCid', () => {
  const ids = ['a', 'b', 'c'];
  it("prefers the route's own connection", () => {
    expect(resolveAccountCid('b', 'c', ids, 'a')).toBe('b');
  });
  it('then the picked server while it is signed in, then the default', () => {
    expect(resolveAccountCid(undefined, 'c', ids, 'a')).toBe('c');
    // The picked server was signed out: back to the default.
    expect(resolveAccountCid(undefined, 'gone', ids, 'a')).toBe('a');
    expect(resolveAccountCid(undefined, null, ids, 'b')).toBe('b');
  });
  it('falls back to the first connection, or null with none', () => {
    expect(resolveAccountCid(undefined, null, ids, null)).toBe('a');
    expect(resolveAccountCid(undefined, null, ids, 'gone')).toBe('a');
    expect(resolveAccountCid(undefined, null, [], null)).toBeNull();
  });
});

describe('signedInSessions', () => {
  it('lists sessions only, this device first, then in the server order', () => {
    const list = [
      device({ id: 1, name: 'Laptop' }),
      device({ id: 2, kind: 'api', name: 'Home Assistant' }),
      device({ id: 3, name: 'This phone', current: true }),
      device({ id: 4, name: 'Tablet' }),
    ];
    expect(signedInSessions(list).map((d) => d.id)).toEqual([3, 1, 4]);
    expect(signedInSessions(undefined)).toEqual([]);
  });
});

describe('canRevoke', () => {
  it('never offers the current device', () => {
    expect(canRevoke({ current: true })).toBe(false);
    expect(canRevoke({ current: false })).toBe(true);
  });
});

describe('lastSeen', () => {
  it('reads this device and a recent request as active now', () => {
    expect(lastSeen(device({ current: true, last_seen: ago(3 * 86400_000) }), NOW)).toEqual({
      kind: 'now',
    });
    expect(lastSeen(device({ last_seen: ago(ACTIVE_NOW_MS - 1000) }), NOW)).toEqual({
      kind: 'now',
    });
  });

  it('reads a device that never made a request as never', () => {
    expect(lastSeen(device({ last_seen: null }), NOW)).toEqual({ kind: 'never' });
    expect(lastSeen(device({ last_seen: 'not a date' }), NOW)).toEqual({ kind: 'never' });
  });

  it('counts whole units ago', () => {
    expect(lastSeen(device({ last_seen: ago(12 * 60_000) }), NOW)).toEqual({
      kind: 'ago',
      unit: 'minute',
      count: 12,
    });
    expect(lastSeen(device({ last_seen: ago(2 * 3600_000 + 60_000) }), NOW)).toEqual({
      kind: 'ago',
      unit: 'hour',
      count: 2,
    });
    expect(lastSeen(device({ last_seen: ago(3 * 86400_000) }), NOW)).toEqual({
      kind: 'ago',
      unit: 'day',
      count: 3,
    });
    expect(lastSeen(device({ last_seen: ago(65 * 86400_000) }), NOW)).toEqual({
      kind: 'ago',
      unit: 'month',
      count: 2,
    });
    expect(lastSeen(device({ last_seen: ago(400 * 86400_000) }), NOW)).toEqual({
      kind: 'ago',
      unit: 'year',
      count: 1,
    });
  });

  it('treats a clock that runs ahead of the server as now, not the future', () => {
    expect(lastSeen(device({ last_seen: ago(-60_000) }), NOW)).toEqual({ kind: 'now' });
  });
});

describe('platforms and glyphs', () => {
  it('knows the three app platforms only', () => {
    expect(knownPlatform('ios')).toBe('ios');
    expect(knownPlatform('android')).toBe('android');
    expect(knownPlatform('web')).toBe('web');
    expect(knownPlatform('macos')).toBeNull();
    expect(knownPlatform(undefined)).toBeNull();
  });

  it('draws a browser as the globe and anything else as a personal device', () => {
    expect(deviceGlyph('web')).toBe('globe');
    expect(deviceGlyph('ios')).toBe('user');
    expect(deviceGlyph(undefined)).toBe('user');
  });
});

describe('avatarHues', () => {
  it('gives a name the same two hues every time, ignoring case and spaces', () => {
    const [a, b] = avatarHues('Chris');
    expect(avatarHues(' chris ')).toEqual([a, b]);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
    expect(b).toBe((a + 50) % 360);
  });
});
