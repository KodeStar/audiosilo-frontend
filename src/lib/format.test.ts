import {
  bookSubtitle,
  formatBitrate,
  formatBytes,
  formatClock,
  formatCountdown,
  formatDuration,
  formatDurationFull,
  formatRelative,
} from '@/lib/format';

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

describe('formatClock', () => {
  it('renders m:ss under an hour, h:mm:ss at or above an hour', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(125)).toBe('2:05'); // m:ss, minutes not zero-padded
    expect(formatClock(3600)).toBe('1:00:00'); // crosses the hour → h:mm:ss, padded m
    expect(formatClock(3723)).toBe('1:02:03');
  });

  it('clamps negatives to 0:00 and floors fractional seconds', () => {
    expect(formatClock(-10)).toBe('0:00');
    expect(formatClock(65.9)).toBe('1:05');
  });
});

describe('formatDuration', () => {
  it('renders the compact h/m/s label across boundaries', () => {
    expect(formatDuration(30)).toBe('30s'); // seconds only under a minute
    expect(formatDuration(90)).toBe('1m'); // minutes drop the seconds
    expect(formatDuration(3600)).toBe('1h'); // whole hour, no trailing minutes
    expect(formatDuration(45030)).toBe('12h 30m'); // hours + minutes
    expect(formatDuration(7200)).toBe('2h');
  });

  it('is empty for zero/undefined/negative', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(-5)).toBe('');
  });
});

describe('formatDurationFull', () => {
  it('renders the two most-significant units, no spaces', () => {
    expect(formatDurationFull(45)).toBe('45s');
    expect(formatDurationFull(532)).toBe('8m52s'); // m + s
    expect(formatDurationFull(5580)).toBe('1h33m'); // h + m
    expect(formatDurationFull(60)).toBe('1m0s'); // exactly a minute keeps the 0s
  });

  it('is empty for zero/undefined', () => {
    expect(formatDurationFull(0)).toBe('');
    expect(formatDurationFull(undefined)).toBe('');
  });
});

describe('formatBitrate', () => {
  it('computes kbps from bytes and duration', () => {
    expect(formatBitrate(2_000_000, 125)).toBe('128kbps');
  });

  it('guards on non-positive duration, missing size, and a zero result', () => {
    expect(formatBitrate(1_000_000, 0)).toBe(''); // duration <= 0
    expect(formatBitrate(1_000_000, -10)).toBe('');
    expect(formatBitrate(undefined, 100)).toBe('');
    expect(formatBitrate(0, 100)).toBe('');
    expect(formatBitrate(10, 100)).toBe(''); // rounds to 0 kbps → empty
  });
});

describe('bookSubtitle', () => {
  it('renders the author alone when there is no series', () => {
    expect(bookSubtitle({ author: 'Brandon Sanderson' })).toBe('Brandon Sanderson');
  });

  it('inlines the series index as "Series #<index>"', () => {
    expect(bookSubtitle({ series: 'Cradle', seriesIndex: 2 })).toBe('Cradle #2');
  });

  it('joins author and series with a middot, omitting a falsy index', () => {
    expect(bookSubtitle({ author: 'Will Wight', series: 'Cradle', seriesIndex: 1 })).toBe(
      'Will Wight · Cradle #1',
    );
    expect(bookSubtitle({ author: 'Will Wight', series: 'Cradle' })).toBe('Will Wight · Cradle');
    expect(bookSubtitle({ author: 'Will Wight', series: 'Cradle', seriesIndex: 0 })).toBe(
      'Will Wight · Cradle',
    );
  });

  it('is empty when nothing is provided', () => {
    expect(bookSubtitle({})).toBe('');
    expect(bookSubtitle({ author: '', series: '' })).toBe('');
  });
});
