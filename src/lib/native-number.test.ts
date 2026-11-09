import { nativeNumber } from './native-number';

describe('nativeNumber', () => {
  it('turns an iOS Int64 (a bigint) into a number', () => {
    expect(nativeNumber(BigInt(0))).toBe(0);
    expect(nativeNumber(BigInt(5_242_880))).toBe(5_242_880);
    expect(typeof nativeNumber(BigInt(1))).toBe('number');
    // A total-disk-space size (beyond 2^32) stays exact.
    expect(nativeNumber(BigInt('255999999999'))).toBe(255_999_999_999);
  });

  it('keeps an Android Long (a number) as it is', () => {
    expect(nativeNumber(1024)).toBe(1024);
    expect(nativeNumber(-1)).toBe(-1);
  });

  it('falls back for a missing or non-finite value', () => {
    expect(nativeNumber(null)).toBe(0);
    expect(nativeNumber(undefined)).toBe(0);
    expect(nativeNumber(Number.NaN)).toBe(0);
    expect(nativeNumber(undefined, -1)).toBe(-1);
  });

  it('can be mixed with numbers afterwards (a bigint alone would throw)', () => {
    const written = BigInt(300);
    const total = BigInt(1200);
    expect(() => Math.max(written as unknown as number, 0)).toThrow(TypeError);
    expect(nativeNumber(written) / nativeNumber(total)).toBe(0.25);
  });
});
