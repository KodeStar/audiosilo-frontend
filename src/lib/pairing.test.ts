import {
  cleanAddresses,
  hostOf,
  normalizeUrl,
  parseInviteScan,
  parsePairingScan,
} from '@/lib/pairing';

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

describe("parsePairingScan with the server's id", () => {
  it('reads sid= from both link carriers', () => {
    expect(parsePairingScan('https://h:8080/web/connect?token=t&sid=Ab_9-x')).toEqual({
      base: 'https://h:8080',
      token: 't',
      serverId: 'Ab_9-x',
    });
    expect(
      parsePairingScan('audiosilo://connect?server=https%3A%2F%2Fh%3A8080&token=t&sid=Ab_9-x')
        ?.serverId,
    ).toBe('Ab_9-x');
  });

  it('drops a blank or malformed sid, and the link pairs without it', () => {
    expect(parsePairingScan('https://h/web/connect?token=t&sid=')).toEqual({
      base: 'https://h',
      token: 't',
    });
    expect(parsePairingScan('https://h/web/connect?token=t&sid=%20%20')).not.toHaveProperty(
      'serverId',
    );
    expect(parsePairingScan('https://h/web/connect?token=t&sid=%E0%A4%A')).toEqual({
      base: 'https://h',
      token: 't',
    });
  });

  it("reads the book a link ends on and the user it was made for (the console's link)", () => {
    const path = 'Brandon Sanderson/Mistborn & Co/01 #1?';
    const q = new URLSearchParams({ token: 't', sid: 'srv-1', uid: '1', book: '2', path });
    expect(parsePairingScan(`https://h/web/connect?${q.toString()}`)).toEqual({
      base: 'https://h',
      token: 't',
      serverId: 'srv-1',
      userId: 1,
      book: { libraryId: 2, path },
    });
    // One it can't name is no book, and no user: the link pairs as any other.
    expect(parsePairingScan('https://h/web/connect?token=t&uid=x&book=2x&path=A')).toEqual({
      base: 'https://h',
      token: 't',
    });
    expect(parsePairingScan('https://h/web/connect?token=t&book=2&path=%E0%A4%A')).toEqual({
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

describe('parseInviteScan (an invite QR or link, #98)', () => {
  it('reads the server and code of an invite link', () => {
    expect(parseInviteScan('https://books.example.com/connect#code=ABCD-EFGH-JKMN-PQRS')).toEqual({
      base: 'https://books.example.com',
      code: 'ABCD-EFGH-JKMN-PQRS',
    });
  });

  it('keeps a port and a base path', () => {
    expect(parseInviteScan('http://192.168.1.5:8080/connect#code=ABCD-1234')).toEqual({
      base: 'http://192.168.1.5:8080',
      code: 'ABCD-1234',
    });
    expect(parseInviteScan(' https://example.com/audiobooks/connect/#code=ABCD-1234 ')).toEqual({
      base: 'https://example.com/audiobooks',
      code: 'ABCD-1234',
    });
  });

  it('reads an encoded code among other fragment params', () => {
    expect(parseInviteScan('https://example.com/connect#x=1&code=ABCD%2D1234')).toEqual({
      base: 'https://example.com',
      code: 'ABCD-1234',
    });
  });

  it('refuses a malformed code, or none', () => {
    for (const raw of [
      'https://example.com/connect#code=',
      'https://example.com/connect#code=AB CD',
      'https://example.com/connect#code=-ABCD',
      'https://example.com/connect#code=ABCD--1234',
      'https://example.com/connect#code=%E0%A4%A',
      'https://example.com/connect#code=<script>',
      `https://example.com/connect#code=${'A'.repeat(65)}`,
      'https://example.com/connect#token=ABCD',
      'https://example.com/connect',
    ]) {
      expect(parseInviteScan(raw)).toBeNull();
    }
  });

  it('refuses another page, a pairing link and a non-http link', () => {
    expect(parseInviteScan('https://example.com/login#code=ABCD-1234')).toBeNull();
    expect(parseInviteScan('https://example.com/web/connect#code=ABCD-1234')).toBeNull();
    expect(parseInviteScan('https://example.com/web/connect?token=abc')).toBeNull();
    expect(parseInviteScan('audiosilo://connect#code=ABCD-1234')).toBeNull();
    expect(parseInviteScan('ftp://example.com/connect#code=ABCD-1234')).toBeNull();
  });

  it('is not a pairing link (the scanner tries both)', () => {
    expect(parsePairingScan('https://example.com/connect#code=ABCD-1234')).toBeNull();
  });
});
