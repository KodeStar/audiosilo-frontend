import { toHex as hex } from './random';
import { chainSalted, hexOfWords, sha256, utf8, wordsOf } from './sha256';

// Node's own implementation, as the reference (the app's tsconfig has no node types).
type NodeHash = { update: (d: Uint8Array) => NodeHash; digest: () => Uint8Array };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHash } = require('crypto') as { createHash: (alg: 'sha256') => NodeHash };

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
      expect(hex(sha256(data))).toBe(hex(createHash('sha256').update(data).digest()));
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

describe('chainSalted (the PIN chain)', () => {
  it("is SHA-256 over salt + the previous digest, round after round, like node's", () => {
    const salt = new Uint8Array(16).map((_, i) => (i * 37 + 11) & 0xff);
    let ref: Uint8Array = createHash('sha256').update(utf8('4821')).digest();
    const digest = wordsOf(new Uint8Array(ref));
    for (const rounds of [1, 2, 7]) {
      for (let i = 0; i < rounds; i++) {
        ref = createHash('sha256')
          .update(new Uint8Array([...salt, ...ref]))
          .digest();
      }
      chainSalted(wordsOf(salt), digest, rounds);
      expect(hexOfWords(digest)).toBe(hex(ref));
    }
  });

  it('reads and spells words big-endian', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x01]);
    expect(hexOfWords(wordsOf(bytes))).toBe('deadbeef00000001');
  });
});
