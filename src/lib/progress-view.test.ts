import {
  isInProgress,
  percentHeard,
  percentOf,
  progressFractionRemaining,
} from '@/lib/progress-view';

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

describe('isInProgress', () => {
  it('is a started, unfinished book', () => {
    expect(isInProgress({ finished: false, position: 12 })).toBe(true);
    expect(isInProgress({ finished: false, position: 0 })).toBe(false);
    expect(isInProgress({ finished: true, position: 12 })).toBe(false);
  });
});

describe('percentHeard', () => {
  it('reads 99% until the book is finished', () => {
    expect(percentHeard(999, 1000, false)).toBe(99);
    expect(percentHeard(1000, 1000, false)).toBe(99);
    expect(percentHeard(400, 1000, true)).toBe(100);
    expect(percentHeard(380, 1000, false)).toBe(38);
    expect(percentHeard(10, 0, false)).toBe(0);
  });
});

describe('percentOf', () => {
  it('rounds down and caps at 99 until finished', () => {
    expect(percentOf(0.996)).toBe(99);
    expect(percentOf(1.2)).toBe(99);
    expect(percentOf(0.379)).toBe(37);
    expect(percentOf(0.004)).toBe(0);
    expect(percentOf(-1)).toBe(0);
    expect(percentOf(0.2, true)).toBe(100);
  });
});
