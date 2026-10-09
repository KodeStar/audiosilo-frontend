import { fnv1a } from './fnv1a';

describe('fnv1a', () => {
  it('is FNV-1a 32 bit as 8 hex digits', () => {
    // The published FNV-1a test vectors.
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('foobar')).toBe('bf9cf968');
  });

  it('is stable and tells strings apart', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });
});
