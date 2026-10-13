import { isLoopbackHost, urlHost } from './url-host';

describe('urlHost', () => {
  it('reads the host without URL.hostname (React Native does not implement it)', () => {
    expect(urlHost('https://Books.Example.com:8443/api')).toBe('books.example.com');
    expect(urlHost('http://[::1]:80')).toBe('::1');
    expect(urlHost('https://user@books.example.com')).toBe('books.example.com');
    expect(urlHost('nope')).toBeNull();
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
