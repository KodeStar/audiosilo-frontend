import { progressFractionRemaining } from '@/lib/progress-view';

describe('progressFractionRemaining', () => {
  it('computes the fraction and remaining seconds', () => {
    expect(progressFractionRemaining(1800, 3600)).toEqual({ fraction: 0.5, remaining: 1800 });
  });

  it('clamps the fraction to 1 and remaining to 0 past the end', () => {
    expect(progressFractionRemaining(4000, 3600)).toEqual({ fraction: 1, remaining: 0 });
  });

  it('treats an unknown/zero duration as no progress', () => {
    expect(progressFractionRemaining(100, 0)).toEqual({ fraction: 0, remaining: 0 });
  });

  it('clamps a negative position to a zero fraction', () => {
    expect(progressFractionRemaining(-5, 3600)).toEqual({ fraction: 0, remaining: 3605 });
  });
});
