import type { MyDevice } from '@/api/types';

import {
  accountParentKey,
  ACTIVE_NOW_MS,
  avatarHues,
  canRevoke,
  deviceGlyph,
  knownPlatform,
  lastSeen,
  PAIRING_TTL_MS,
  pairingSecondsLeft,
  resolveAccountCid,
  routeUnderAccount,
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

  it('reads a clock from before the code arrived as a fresh code', () => {
    expect(pairingSecondsLeft(NOW + PAIRING_TTL_MS, NOW - 42_000)).toBe(600);
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

  it('draws a key, a laptop, a tablet or a phone', () => {
    const web = { app: 'audiosilo-web', version: '1', platform: 'web' };
    const ios = { app: 'audiosilo', version: '1', platform: 'ios' };
    expect(deviceGlyph({ kind: 'api', name: 'Heimdall', client: web })).toBe('key');
    expect(deviceGlyph({ kind: 'session', name: 'Firefox', client: web })).toBe('laptop');
    expect(deviceGlyph({ kind: 'session', name: "Chris's iPad", client: ios })).toBe('tablet');
    expect(deviceGlyph({ kind: 'session', name: 'Galaxy Tab S9', client: null })).toBe('tablet');
    expect(deviceGlyph({ kind: 'session', name: 'iPhone 15', client: ios })).toBe('mobile');
    // "Tabby's phone" is not a tablet; an app that hasn't said yet is what its name says.
    expect(deviceGlyph({ kind: 'session', name: "Tabby's phone", client: null })).toBe('mobile');
    expect(deviceGlyph({ kind: 'session', name: "Alex's Pixel 8", client: null })).toBe('mobile');
    // Nothing says what it is ("Fixture web", "App not reported yet"): a neutral glyph.
    expect(deviceGlyph({ kind: 'session', name: 'Fixture web', client: null })).toBe('hard-drive');
    expect(deviceGlyph({ kind: 'session', name: 'Kitchen', client: undefined })).toBe('hard-drive');
    // A reported app is a phone whatever its name.
    expect(deviceGlyph({ kind: 'session', name: 'Kitchen', client: ios })).toBe('mobile');
  });
});

describe('the Account page crumb', () => {
  const tabRoot = { name: 'library/index' };
  it('finds the route the page was pushed over', () => {
    expect(routeUnderAccount([tabRoot, { name: 'settings' }, { name: 'account' }])).toEqual({
      name: 'settings',
    });
    expect(routeUnderAccount([{ name: 'account' }])).toBeUndefined();
    expect(routeUnderAccount([tabRoot])).toBeUndefined();
  });

  it('names Settings or the hub section, and nothing else', () => {
    expect(accountParentKey({ name: 'settings', params: { section: 'accounts' } })).toBe(
      'settings.title',
    );
    expect(accountParentKey({ name: 'you', params: { section: 'settings' } })).toBe(
      'you.titles.settings',
    );
    expect(accountParentKey({ name: 'you' })).toBe('you.titles.stats');
    expect(accountParentKey({ name: 'book/[libraryId]' })).toBeNull();
    expect(accountParentKey(undefined)).toBeNull();
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
