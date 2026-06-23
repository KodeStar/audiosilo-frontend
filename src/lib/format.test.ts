import { formatCountdown } from '@/lib/format';

describe('formatCountdown', () => {
  it('formats minutes and seconds with a space', () => {
    expect(formatCountdown(312)).toBe('5m 12s');
    expect(formatCountdown(1074)).toBe('17m 54s');
    expect(formatCountdown(1519)).toBe('25m 19s');
    expect(formatCountdown(2222)).toBe('37m 2s');
  });

  it('drops to hours and minutes past an hour', () => {
    expect(formatCountdown(3900)).toBe('1h 5m');
    expect(formatCountdown(3600)).toBe('1h');
  });

  it('shows seconds only under a minute and clamps negatives to zero', () => {
    expect(formatCountdown(45)).toBe('45s');
    expect(formatCountdown(0)).toBe('0s');
    expect(formatCountdown(-10)).toBe('0s');
  });
});
