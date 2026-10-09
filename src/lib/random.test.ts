import { randomBytes, randomUUID, resetRandomForTests, toHex } from './random';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('random', () => {
  beforeEach(resetRandomForTests);

  it('gives bytes of the asked length, different each time', () => {
    const a = randomBytes(16);
    expect(a).toHaveLength(16);
    expect(toHex(a)).not.toBe(toHex(randomBytes(16)));
  });

  it('gives v4 UUIDs', () => {
    expect(randomUUID()).toMatch(UUID);
    expect(randomUUID()).not.toBe(randomUUID());
  });

  it('builds a UUID itself where the runtime has no randomUUID (an insecure web page)', () => {
    const c = globalThis.crypto as { randomUUID?: unknown };
    const saved = c.randomUUID;
    Object.defineProperty(c, 'randomUUID', { value: undefined, configurable: true });
    try {
      expect(randomUUID()).toMatch(UUID);
    } finally {
      Object.defineProperty(c, 'randomUUID', { value: saved, configurable: true });
    }
  });

  it('hex-encodes bytes', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });
});
