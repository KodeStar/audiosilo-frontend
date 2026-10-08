import { cleanAddresses, hostOf, normalizeUrl, parsePairingScan } from '@/lib/pairing';

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

describe('cleanAddresses', () => {
  it('normalises both and drops what is not an http(s) URL', () => {
    expect(
      cleanAddresses({ home: ' http://192.168.1.20:8080/ ', away: 'https://books.example.com' }),
    ).toEqual({ home: 'http://192.168.1.20:8080', away: 'https://books.example.com' });
    expect(cleanAddresses({ home: 'ftp://nas', away: 'not a host' })).toBeUndefined();
    expect(cleanAddresses({ home: 42, away: null })).toBeUndefined();
    expect(cleanAddresses(null)).toBeUndefined();
  });
  it('drops a home that is the away address too', () => {
    expect(cleanAddresses({ home: 'https://b.example', away: 'https://b.example/' })).toEqual({
      away: 'https://b.example',
    });
  });
});

describe('parsePairingScan with home and away addresses', () => {
  const home = encodeURIComponent('http://192.168.1.20:8080');
  const away = encodeURIComponent('https://books.example.com');

  it('reads them from the web handoff URL (the QR)', () => {
    expect(
      parsePairingScan(`https://books.example.com/web/connect?token=tok&home=${home}&away=${away}`),
    ).toEqual({
      base: 'https://books.example.com',
      token: 'tok',
      addresses: { home: 'http://192.168.1.20:8080', away: 'https://books.example.com' },
    });
  });

  it('reads them from the custom-scheme deep link', () => {
    const scan = parsePairingScan(
      `audiosilo://connect?server=${home}&token=tok&home=${home}&away=${away}`,
    );
    expect(scan).toEqual({
      base: 'http://192.168.1.20:8080',
      token: 'tok',
      addresses: { home: 'http://192.168.1.20:8080', away: 'https://books.example.com' },
    });
  });

  it('keeps just the valid one, and no field at all without any', () => {
    expect(parsePairingScan(`https://h/web/connect?token=t&home=nope%20nope&away=${away}`)).toEqual(
      { base: 'https://h', token: 't', addresses: { away: 'https://books.example.com' } },
    );
    expect(parsePairingScan('https://h/web/connect?token=t&home=&away=')).not.toHaveProperty(
      'addresses',
    );
    expect(parsePairingScan('https://h/web/connect?token=t')).not.toHaveProperty('addresses');
  });

  it('pairs without a malformed address param instead of failing the link', () => {
    expect(parsePairingScan('https://h/web/connect?token=t&home=%E0%A4%A')).toEqual({
      base: 'https://h',
      token: 't',
    });
  });
});

describe('hostOf', () => {
  it('is the host and port, without the scheme or a path', () => {
    expect(hostOf('https://books.example.com:8443/base')).toBe('books.example.com:8443');
    expect(hostOf('HTTP://192.168.1.20:8080')).toBe('192.168.1.20:8080');
    expect(hostOf('books.example.com')).toBe('books.example.com');
  });
});
