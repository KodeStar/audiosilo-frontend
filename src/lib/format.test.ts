import { formatBytes, formatCountdown, formatRelative } from '@/lib/format';

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

describe('formatRelative', () => {
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

  it('localises coarse relative time via Intl', () => {
    expect(formatRelative(ago(10), 'en')).toBe('now');
    expect(formatRelative(ago(3 * 86400), 'en')).toBe('3 days ago');
    expect(formatRelative(ago(3 * 86400), 'es')).toBe('hace 3 días');
    expect(formatRelative(ago(60 * 86400), 'en')).toBe('2 months ago');
  });

  it('returns empty for missing or unparseable input', () => {
    expect(formatRelative(undefined, 'en')).toBe('');
    expect(formatRelative('not-a-date', 'en')).toBe('');
  });
});

describe('formatBytes', () => {
  it('formats with locale-aware decimals and universal unit symbols', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(1536, 'de')).toBe('1,5 KB');
    expect(formatBytes(1610612736, 'en')).toBe('1.5 GB');
  });
});
