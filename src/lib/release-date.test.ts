import { parseReleaseDate, releaseIsFuture } from './release-date';

const NOW = new Date('2026-10-30T15:00:00Z');

describe('parseReleaseDate', () => {
  it('splits a stated date at its own precision, with its first day', () => {
    expect(parseReleaseDate('2027')).toEqual({ year: '2027', start: '2027-01-01' });
    expect(parseReleaseDate('2026-11')).toMatchObject({ month: '11', start: '2026-11-01' });
    expect(parseReleaseDate('2026-11-12')).toMatchObject({ day: '12', start: '2026-11-12' });
  });

  it('reads nothing else as a date', () => {
    for (const v of [undefined, '', 'Nov 2026', '2026-13', '2026-02-30', '2026-1-5']) {
      expect(parseReleaseDate(v)).toBeNull();
    }
  });
});

describe('releaseIsFuture', () => {
  it('reads a day against the UTC day: today is out, tomorrow is ahead', () => {
    expect(releaseIsFuture('2026-10-31', NOW)).toBe(true);
    expect(releaseIsFuture('2026-10-30', NOW)).toBe(false);
    expect(releaseIsFuture('2026-10-29', NOW)).toBe(false);
    // Late in the evening west of UTC it is already the next UTC day.
    expect(releaseIsFuture('2026-10-31', new Date('2026-10-31T00:30:00Z'))).toBe(false);
  });

  it('counts a month or a year as ahead only when the whole period is', () => {
    expect(releaseIsFuture('2026-11', NOW)).toBe(true);
    expect(releaseIsFuture('2026-10', NOW)).toBe(false);
    expect(releaseIsFuture('2026-09', NOW)).toBe(false);
    expect(releaseIsFuture('2027', NOW)).toBe(true);
    expect(releaseIsFuture('2026', NOW)).toBe(false);
    expect(releaseIsFuture('2025', NOW)).toBe(false);
  });

  it('never calls an absent or unreadable date ahead', () => {
    expect(releaseIsFuture(undefined, NOW)).toBe(false);
    expect(releaseIsFuture('', NOW)).toBe(false);
    expect(releaseIsFuture('soon', NOW)).toBe(false);
    expect(releaseIsFuture('2027-13', NOW)).toBe(false);
    expect(releaseIsFuture('2027-02-30', NOW)).toBe(false);
    expect(releaseIsFuture('2027-1-5', NOW)).toBe(false);
  });
});
