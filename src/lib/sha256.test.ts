import { createHash } from 'crypto';

import { sha256, utf8 } from './sha256';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('sha256', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(hex(sha256(utf8('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hex(sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it("agrees with node's crypto at every padding boundary", () => {
    for (let n = 0; n < 200; n++) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
      expect(hex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });

  it('encodes UTF-8 like TextEncoder, also without it', () => {
    const s = 'Zoë 東京 \u{1F600}';
    const native = utf8(s);
    const saved = globalThis.TextEncoder;
    // @ts-expect-error -- simulate a runtime without TextEncoder
    delete globalThis.TextEncoder;
    try {
      expect(Array.from(utf8(s))).toEqual(Array.from(native));
    } finally {
      globalThis.TextEncoder = saved;
    }
  });
});
