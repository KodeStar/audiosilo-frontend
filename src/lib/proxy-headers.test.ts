import {
  cleanProxyHeaders,
  MAX_PROXY_HEADER_VALUE,
  MAX_PROXY_HEADERS,
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
