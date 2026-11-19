import {
  canManageProxySet,
  cleanProxyHeaders,
  MAX_PROXY_HEADER_VALUE,
  MAX_PROXY_HEADERS,
  mayReplaceProxySet,
  originOf,
  proxyHeaderProblem,
  proxyHeaderProblems,
  proxyHeaderRecord,
  sameProxyHeaders,
} from './proxy-headers';

const SET = {
  origin: 'https://books.example.com',
  headers: [
    { name: 'CF-Access-Client-Id', value: 'id.access' },
    { name: 'CF-Access-Client-Secret', value: 'proxy-secret' },
  ],
};

describe('proxyHeaderProblem', () => {
  it('takes a header name and a one-line value', () => {
    expect(proxyHeaderProblem({ name: ' X-Auth-Token ', value: ' abc def ' })).toBeNull();
  });

  it('refuses what is not a header name', () => {
    expect(proxyHeaderProblem({ name: '', value: 'v' })).toBe('name');
    expect(proxyHeaderProblem({ name: 'Two words', value: 'v' })).toBe('name');
    expect(proxyHeaderProblem({ name: 'X:Y', value: 'v' })).toBe('name');
  });

  it('refuses the names the app or the platform sends, whatever the case', () => {
    for (const name of [
      'Authorization',
      'authorization',
      'X-AudioSilo-Client',
      'Content-Type',
      'Range',
      'Host',
      'Cookie',
    ]) {
      expect(proxyHeaderProblem({ name, value: 'v' })).toBe('reserved');
    }
  });

  it('refuses the same name twice', () => {
    expect(
      proxyHeaderProblems([
        { name: 'X-A', value: '1' },
        { name: 'x-a', value: '2' },
      ]),
    ).toEqual([null, 'duplicate']);
  });

  it('refuses an empty value, a line break or a control character, and a pasted page', () => {
    expect(proxyHeaderProblem({ name: 'X-A', value: '   ' })).toBe('value');
    expect(proxyHeaderProblem({ name: 'X-A', value: 'a\r\nX-Evil: 1' })).toBe('value');
    expect(proxyHeaderProblem({ name: 'X-A', value: 'a\u0000b' })).toBe('value');
    expect(proxyHeaderProblem({ name: 'X-A', value: 'café' })).toBe('value');
    expect(proxyHeaderProblem({ name: 'X-A', value: 'a'.repeat(MAX_PROXY_HEADER_VALUE + 1) })).toBe(
      'value',
    );
  });
});

describe('cleanProxyHeaders', () => {
  it('keeps the good headers, trimmed, for an https origin', () => {
    expect(
      cleanProxyHeaders('https://books.example.com/web/', [
        { name: ' CF-Access-Client-Id ', value: ' id.access ' },
        { name: 'Authorization', value: 'Basic x' },
        { name: 'CF-Access-Client-Secret', value: 'proxy-secret' },
      ]),
    ).toEqual(SET);
  });

  it('keeps at most MAX_PROXY_HEADERS', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `X-${i}`, value: 'v' }));
    expect(cleanProxyHeaders(SET.origin, many)?.headers).toHaveLength(MAX_PROXY_HEADERS);
  });

  it('is null with nothing to keep, or no https origin (never over plain http)', () => {
    expect(cleanProxyHeaders('http://books.example.com', SET.headers)).toBeNull();
    expect(cleanProxyHeaders('http://192.168.1.5:8080', SET.headers)).toBeNull();
    expect(cleanProxyHeaders(SET.origin, [])).toBeNull();
    expect(cleanProxyHeaders(SET.origin, [{ name: 'Cookie', value: 'x' }])).toBeNull();
    expect(cleanProxyHeaders('ftp://books.example.com', SET.headers)).toBeNull();
    expect(cleanProxyHeaders(null, SET.headers)).toBeNull();
    expect(cleanProxyHeaders(SET.origin, null)).toBeNull();
  });
});

describe('proxyHeaderRecord (the one origin rule)', () => {
  const record = { 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 'proxy-secret' };

  it('gives them to a request on their origin (native)', () => {
    expect(proxyHeaderRecord(SET, 'https://books.example.com/api/v1/server', 'ios', null)).toEqual(
      record,
    );
    expect(proxyHeaderRecord(SET, 'https://books.example.com:443', 'android', null)).toEqual(
      record,
    );
  });

  it('never to another origin: another host, port or scheme (the home address, an http fallback)', () => {
    for (const url of [
      'https://evil.example.com/api/v1/server',
      'https://books.example.com:8443/api/v1/server',
      'http://books.example.com/api/v1/server',
      'http://192.168.1.5:8080/api/v1/server',
      'https://books.example.com.evil.example/x',
      'not a url',
    ]) {
      expect(proxyHeaderRecord(SET, url, 'ios', null)).toEqual({});
    }
  });

  it('on the web only same-origin with the page (a custom header cross-origin needs CORS)', () => {
    const url = 'https://books.example.com/api/v1/server';
    expect(proxyHeaderRecord(SET, url, 'web', 'https://books.example.com')).toEqual(record);
    expect(proxyHeaderRecord(SET, url, 'web', 'http://localhost:8081')).toEqual({});
    expect(proxyHeaderRecord(SET, url, 'web', null)).toEqual({});
  });

  it('never over plain http, even for a set naming an http origin', () => {
    const http = { ...SET, origin: 'http://192.168.1.5:8080' };
    expect(proxyHeaderRecord(http, 'http://192.168.1.5:8080/api/v1/server', 'ios', null)).toEqual(
      {},
    );
    const page = 'http://192.168.1.5:8080';
    expect(proxyHeaderRecord(http, `${page}/api/v1/server`, 'web', page)).toEqual({});
  });

  it('is empty with no set', () => {
    expect(proxyHeaderRecord(null, 'https://books.example.com', 'ios', null)).toEqual({});
    expect(proxyHeaderRecord(undefined, 'https://books.example.com', 'ios', null)).toEqual({});
  });
});

describe('helpers', () => {
  it('originOf takes http(s) only', () => {
    expect(originOf('https://Books.Example.com/web')).toBe('https://books.example.com');
    expect(originOf('audiosilo://connect')).toBeNull();
    expect(originOf('')).toBeNull();
  });

  it('sameProxyHeaders compares origin, names and values in order', () => {
    expect(sameProxyHeaders(SET, { ...SET, headers: [...SET.headers] })).toBe(true);
    expect(sameProxyHeaders(SET, { ...SET, origin: 'https://other.example' })).toBe(false);
    expect(
      sameProxyHeaders(SET, {
        ...SET,
        headers: [SET.headers[0], { ...SET.headers[1], value: 'x' }],
      }),
    ).toBe(false);
    expect(sameProxyHeaders(undefined, null)).toBe(true);
    expect(sameProxyHeaders(SET, undefined)).toBe(false);
  });
});

// fe#295: one set per address, shared by everyone on the device. A demo or a kid's account
// must not remove it for the others.
describe('canManageProxySet', () => {
  const AWAY = 'https://books.example.com';
  const set = { origin: AWAY, headers: [{ name: 'X-Proxy', value: 's' }] };
  const conn = (id: string, user: { is_demo?: boolean; member_kind?: 'kid' } = {}) => ({
    id,
    serverUrl: AWAY,
    user,
  });
  const owner = conn('srv.1');
  const kid = conn('srv.2', { member_kind: 'kid' });
  const demo = conn('srv.3', { is_demo: true });

  it('always lets a full account manage the set, shared or not', () => {
    expect(canManageProxySet(owner, set, [owner, kid])).toBe(true);
    expect(canManageProxySet(owner, null, [owner])).toBe(true);
    expect(canManageProxySet(null, set, [owner])).toBe(false);
  });

  it("never lets a demo or a kid's account change a set a full account here signs in through", () => {
    expect(canManageProxySet(kid, set, [owner, kid])).toBe(false);
    expect(canManageProxySet(demo, set, [owner, demo])).toBe(false);
    // Through any of that account's addresses.
    const elsewhere = { ...conn('srv.1'), serverUrl: 'http://192.168.1.5:8080' };
    expect(canManageProxySet(kid, set, [elsewhere, kid])).toBe(true);
    expect(
      canManageProxySet(kid, set, [{ ...elsewhere, addresses: { away: `${AWAY}/` } }, kid]),
    ).toBe(false);
  });

  it('lets them manage one no full account here uses (theirs alone, or among themselves)', () => {
    expect(canManageProxySet(kid, set, [kid])).toBe(true);
    expect(canManageProxySet(demo, set, [demo, kid])).toBe(true);
    expect(
      canManageProxySet(kid, set, [
        { ...conn('other.1'), serverUrl: 'https://other.example.net' },
        kid,
      ]),
    ).toBe(true);
  });

  it("gives a kid's account the card to add a set only where no full account signs in", () => {
    expect(canManageProxySet(kid, null, [kid])).toBe(true);
    expect(canManageProxySet(kid, null, [owner, kid])).toBe(false);
    expect(canManageProxySet(demo, null, [demo])).toBe(false);
  });

  // The card can move a set to another of the connection's addresses ("Send to"): one a
  // full account signs in through is not theirs to write either.
  it('counts every address the card could write to, not only the one the set is kept for', () => {
    const HOME = 'https://home.example.org';
    const both = { ...kid, addresses: { home: HOME } };
    const atHome = { ...conn('other.1'), serverUrl: HOME };
    expect(canManageProxySet(both, set, [atHome, both])).toBe(false);
    expect(canManageProxySet(both, set, [both])).toBe(true);
  });
});

describe('mayReplaceProxySet', () => {
  const AWAY = 'https://books.example.com';
  const owner = { id: 'srv.1', serverUrl: AWAY, user: {} };
  const kid = { id: 'srv.2', serverUrl: AWAY, user: { member_kind: 'kid' as const } };
  const demo = { id: 'srv.3', serverUrl: AWAY, user: { is_demo: true } };

  it('lets a full account replace the set whoever else signs in through it', () => {
    expect(mayReplaceProxySet(owner.user, owner.id, AWAY, [owner, kid])).toBe(true);
  });

  it("lets a demo or a kid's account replace it only while no full account here reaches it", () => {
    expect(mayReplaceProxySet(kid.user, kid.id, AWAY, [owner, kid])).toBe(false);
    expect(mayReplaceProxySet(demo.user, demo.id, AWAY, [owner, demo])).toBe(false);
    expect(mayReplaceProxySet(kid.user, kid.id, AWAY, [kid, demo])).toBe(true);
    // Only the address in question counts.
    const elsewhere = { ...owner, serverUrl: 'http://192.168.1.5:8080' };
    expect(mayReplaceProxySet(kid.user, kid.id, AWAY, [elsewhere, kid])).toBe(true);
  });
});
