import { httpUrl, isLoopbackHost, looksLikeHomeAddress, urlEndpoint, urlHost } from './url-host';

describe('urlHost', () => {
  it('reads the host without URL.hostname (React Native does not implement it)', () => {
    expect(urlHost('https://Books.Example.com:8443/api')).toBe('books.example.com');
    expect(urlHost('http://[::1]:80')).toBe('::1');
    expect(urlHost('https://user@books.example.com')).toBe('books.example.com');
    expect(urlHost('nope')).toBeNull();
  });
});

describe('urlEndpoint', () => {
  it("reads the scheme, host and port, the port defaulting to the scheme's", () => {
    expect(urlEndpoint('HTTPS://Books.Example.com:8443/api')).toEqual({
      scheme: 'https',
      host: 'books.example.com',
      port: '8443',
      userinfo: false,
    });
    expect(urlEndpoint('https://nas.local')).toEqual({
      scheme: 'https',
      host: 'nas.local',
      port: '443',
      userinfo: false,
    });
    expect(urlEndpoint('http://user@[fd00::5]?x')).toEqual({
      scheme: 'http',
      host: 'fd00::5',
      port: '80',
      userinfo: true,
    });
    expect(urlEndpoint('ftp://files.example')?.port).toBe('');
    // A scheme named like an Object.prototype member has no default port either.
    expect(urlEndpoint('constructor://files.example')?.port).toBe('');
    expect(urlEndpoint('nope')).toBeNull();
  });
});

describe('isLoopbackHost', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['audiosilo.localhost', true],
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['::1', true],
    ['0.0.0.0', true],
    ['::', true],
    ['192.168.1.10', false],
    ['books.example.com', false],
    ['fd00::1', false],
  ])('%s -> %s', (host, loopback) => {
    expect(isLoopbackHost(host)).toBe(loopback);
  });
});

describe('looksLikeHomeAddress', () => {
  it.each([
    ['192.168.1.20:8080', true],
    ['http://10.0.0.5', true],
    ['172.16.0.1', true],
    ['172.31.255.1', true],
    ['172.32.0.1', false],
    ['169.254.10.1', true],
    ['100.64.0.1', false],
    ['8.8.8.8', false],
    ['http://[fd12:3456::1]:8080', true],
    ['http://[fe80::1]', true],
    ['http://[2001:db8::1]', false],
    ['nas.local', true],
    ['books.lan:8080', true],
    ['shelf.home.arpa', true],
    ['nas', true],
    ['localhost:8080', false],
    ['127.0.0.1', false],
    ['http://[::1]', false],
    ['books.example.com', false],
    ['', false],
  ])('%s -> %s', (url, home) => {
    expect(looksLikeHomeAddress(url)).toBe(home);
  });
});

describe('httpUrl', () => {
  it('keeps an absolute http(s) URL, trimmed, its scheme lower-cased', () => {
    expect(httpUrl(' HTTPS://Books.example.com/X ')).toBe('https://Books.example.com/X');
    expect(httpUrl('http://192.168.1.20:8080/')).toBe('http://192.168.1.20:8080/');
  });

  it('refuses any other scheme, a relative path or no host', () => {
    for (const bad of ['javascript:alert(1)', 'file:///x', 'intent://x', '/x', 'https://', ''])
      expect(httpUrl(bad)).toBeNull();
  });
});

it('urlEndpoint userinfo: a user before the host, never an @ in the path', () => {
  expect(urlEndpoint('https://librivox.org@evil.example/')?.userinfo).toBe(true);
  expect(urlEndpoint('https://u:p@librivox.org/')?.userinfo).toBe(true);
  expect(urlEndpoint('https://librivox.org/a@b')?.userinfo).toBe(false);
  expect(urlEndpoint('https://librivox.org/?q=a@b')?.userinfo).toBe(false);
});
