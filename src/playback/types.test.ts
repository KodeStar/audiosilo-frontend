import { clampVolume } from './types';

describe('clampVolume', () => {
  it('passes through a valid gain', () => {
    expect(clampVolume(0)).toBe(0);
    expect(clampVolume(0.37)).toBe(0.37);
    expect(clampVolume(1)).toBe(1);
  });

  it('clamps out-of-range values (web throws on an out-of-range audio.volume)', () => {
    expect(clampVolume(-0.5)).toBe(0);
    expect(clampVolume(2)).toBe(1);
  });

  it('falls back to full volume for a non-finite value, never silence', () => {
    // A fade dividing by a zero-length duration yields NaN; leaving the user with audio
    // they can't unmute would be worse than a fade that simply doesn't fade.
    expect(clampVolume(NaN)).toBe(1);
    expect(clampVolume(Infinity)).toBe(1);
    expect(clampVolume(-Infinity)).toBe(1);
  });
});
