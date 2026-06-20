import { normalizeUrl, parsePairingScan } from '@/lib/pairing';

describe('normalizeUrl', () => {
  it('adds a default https scheme when none is given', () => {
    expect(normalizeUrl('books.example.com')).toBe('https://books.example.com');
  });
  it('keeps an explicit http/https scheme', () => {
    expect(normalizeUrl('http://192.168.1.5:8080')).toBe('http://192.168.1.5:8080');
    expect(normalizeUrl('https://books.example.com')).toBe('https://books.example.com');
  });
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeUrl('  https://books.example.com//  ')).toBe('https://books.example.com');
  });
  it('returns an empty string for blank input', () => {
    expect(normalizeUrl('   ')).toBe('');
  });
  it('rejects malformed inputs (review finding F5)', () => {
    expect(normalizeUrl('not a valid host')).toBe('');
    expect(normalizeUrl('https://')).toBe('');
  });
});

describe('parsePairingScan', () => {
  it('parses the web handoff URL, preserving host:port and stripping /web/connect', () => {
    expect(parsePairingScan('https://books.example.com:8443/web/connect?token=abc123')).toEqual({
      base: 'https://books.example.com:8443',
      token: 'abc123',
    });
  });
  it('parses the custom-scheme deep link', () => {
    expect(
      parsePairingScan('audiosilo://connect?server=https://books.example.com&token=tok'),
    ).toEqual({
      base: 'https://books.example.com',
      token: 'tok',
    });
  });
  it('url-decodes the token (and converts + to space)', () => {
    expect(parsePairingScan('https://h/web/connect?token=a%2Bb+c')?.token).toBe('a+b c');
  });
  it('returns null without a token', () => {
    expect(parsePairingScan('https://books.example.com/web/connect')).toBeNull();
  });
  it('returns null for unrecognized text', () => {
    expect(parsePairingScan('just some text')).toBeNull();
  });
  it('returns null for a custom-scheme link missing its server', () => {
    expect(parsePairingScan('audiosilo://connect?token=tok')).toBeNull();
  });
});
