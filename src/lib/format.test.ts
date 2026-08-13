import {
  bookSubtitle,
  formatBitrate,
  formatBytes,
  formatClock,
  formatCountdown,
  formatDuration,
  formatDurationFull,
  formatRelative,
  formatTimeOfDay,
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

  it('falls back to plain English when Intl.RelativeTimeFormat is absent (Hermes/RN)', () => {
    // Hermes (React Native) ships Intl.NumberFormat but not RelativeTimeFormat.
    const intl = Intl as unknown as Record<string, unknown>;
    const original = intl.RelativeTimeFormat;
    delete intl.RelativeTimeFormat;
    try {
      expect(formatRelative(ago(10), 'en')).toBe('just now');
      expect(formatRelative(ago(3 * 86400), 'en')).toBe('3 days ago');
      expect(formatRelative(ago(3600), 'en')).toBe('1 hour ago');
      expect(formatRelative(ago(60 * 86400), 'en')).toBe('2 months ago');
    } finally {
      intl.RelativeTimeFormat = original;
    }
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

describe('formatTimeOfDay', () => {
  // ICU has changed which space it puts before AM/PM between versions, so compare
  // on normalised whitespace rather than pinning the exact code point.
  const spaces = (s: string) => s.replace(/\s/g, ' ');

  it('renders the reader own clock convention', () => {
    expect(spaces(formatTimeOfDay('22:00', 'en-US'))).toBe('10:00 PM');
    expect(spaces(formatTimeOfDay('06:30', 'en-US'))).toBe('6:30 AM');
    expect(formatTimeOfDay('22:00', 'de')).toBe('22:00');
    expect(formatTimeOfDay('06:30', 'en-GB')).toBe('6:30');
  });

  it('returns a malformed value unchanged', () => {
    expect(formatTimeOfDay('24:00', 'en-US')).toBe('24:00');
    expect(formatTimeOfDay('nope', 'en-US')).toBe('nope');
  });

  it('falls back to the stored 24h form when Intl.DateTimeFormat throws (Hermes)', () => {
    // Hermes ships a reduced Intl; a locale it cannot build must not crash a screen.
    const intl = Intl as unknown as Record<string, unknown>;
    const original = intl.DateTimeFormat;
    intl.DateTimeFormat = function Broken() {
      throw new RangeError('no Intl here');
    };
    try {
      // A locale no other case in this file formats, so nothing is cached for it.
      expect(formatTimeOfDay('22:00', 'ko')).toBe('22:00');
    } finally {
      intl.DateTimeFormat = original;
    }
  });

  it('builds one formatter per locale and reuses it', () => {
    const intl = Intl as unknown as Record<string, unknown>;
    const original = intl.DateTimeFormat as typeof Intl.DateTimeFormat;
    const spy = jest.fn(
      (locale?: string, options?: Intl.DateTimeFormatOptions) => new original(locale, options),
    );
    intl.DateTimeFormat = spy;
    try {
      expect(formatTimeOfDay('22:00', 'ja')).toBeTruthy();
      expect(formatTimeOfDay('06:30', 'ja')).toBeTruthy();
      expect(formatTimeOfDay('06:30', 'ja')).toBeTruthy();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      intl.DateTimeFormat = original;
    }
  });

  it('formats in the same zone the formatter resolves', () => {
    // A cached formatter resolves its zone once, when it is built; a value assembled
    // from local-time components re-reads the live zone on every call. Let those two
    // disagree - which is what a device whose zone changed under a long-lived JS
    // context does - and a 22:00 bound renders as 3:00 AM. Stand-in for the travelling
    // device: a formatter that resolves a zone a local-time Date would not be built in.
    const local = new Date(2000, 0, 1, 22, 0);
    const rendersLocalAs22 = (timeZone: string) =>
      new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone,
      }).format(local) === '22:00';
    const elsewhere = ['Asia/Tokyo', 'America/New_York'].find((z) => !rendersLocalAs22(z)) ?? 'UTC';

    const intl = Intl as unknown as Record<string, unknown>;
    const original = intl.DateTimeFormat as typeof Intl.DateTimeFormat;
    // `jest.fn`, not an arrow: `formatTimeOfDay` uses `new`, which an arrow function
    // cannot service (it would throw straight into the Hermes fallback and the test
    // would pass against anything).
    intl.DateTimeFormat = jest.fn(
      (locale?: string, options?: Intl.DateTimeFormatOptions) =>
        new original(locale, { ...options, timeZone: options?.timeZone ?? elsewhere }),
    );
    try {
      // A 24h locale nothing else in this file formats, so it builds a fresh formatter.
      expect(formatTimeOfDay('22:00', 'fr')).toBe('22:00');
    } finally {
      intl.DateTimeFormat = original;
    }
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
