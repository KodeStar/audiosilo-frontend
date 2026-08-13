import { formatHhMm, parseHhMm, withinAutoSleepWindow } from '@/lib/hhmm';

/** A local-time Date at HH:MM on an arbitrary fixed day. */
const at = (hh: number, mm: number) => new Date(2026, 0, 15, hh, mm);

describe('withinAutoSleepWindow', () => {
  it('matches both sides of a window that wraps past midnight', () => {
    expect(withinAutoSleepWindow('22:00', '06:00', at(22, 0))).toBe(true); // on the start bound
    expect(withinAutoSleepWindow('22:00', '06:00', at(23, 30))).toBe(true); // before midnight
    expect(withinAutoSleepWindow('22:00', '06:00', at(0, 15))).toBe(true); // after midnight
    expect(withinAutoSleepWindow('22:00', '06:00', at(5, 59))).toBe(true); // just inside the end
  });

  it('rejects times outside a wrapping window', () => {
    expect(withinAutoSleepWindow('22:00', '06:00', at(6, 0))).toBe(false); // end is exclusive
    expect(withinAutoSleepWindow('22:00', '06:00', at(12, 0))).toBe(false);
    expect(withinAutoSleepWindow('22:00', '06:00', at(21, 59))).toBe(false);
  });

  it('handles a same-day window', () => {
    expect(withinAutoSleepWindow('09:00', '17:00', at(9, 0))).toBe(true);
    expect(withinAutoSleepWindow('09:00', '17:00', at(12, 30))).toBe(true);
    expect(withinAutoSleepWindow('09:00', '17:00', at(17, 0))).toBe(false);
    expect(withinAutoSleepWindow('09:00', '17:00', at(8, 59))).toBe(false);
    expect(withinAutoSleepWindow('09:00', '17:00', at(23, 0))).toBe(false);
  });

  it('treats a zero-length window (from === until) as never', () => {
    expect(withinAutoSleepWindow('22:00', '22:00', at(22, 0))).toBe(false);
    expect(withinAutoSleepWindow('22:00', '22:00', at(3, 0))).toBe(false);
  });

  it('rejects a malformed bound rather than arming', () => {
    expect(withinAutoSleepWindow('', '06:00', at(23, 0))).toBe(false);
    expect(withinAutoSleepWindow('22:00', '25:00', at(23, 0))).toBe(false);
    expect(withinAutoSleepWindow('10pm', '06:00', at(23, 0))).toBe(false);
  });
});

describe('HH:MM helpers', () => {
  it('parses canonical values and rejects the rest', () => {
    expect(parseHhMm('00:00')).toBe(0);
    expect(parseHhMm('22:30')).toBe(22 * 60 + 30);
    expect(parseHhMm('23:59')).toBe(23 * 60 + 59);
    expect(parseHhMm('24:00')).toBeNull();
    expect(parseHhMm('7:00')).toBeNull();
    expect(parseHhMm('nope')).toBeNull();
  });

  it('wraps around the day when formatting', () => {
    expect(formatHhMm(0)).toBe('00:00');
    expect(formatHhMm(9 * 60 + 5)).toBe('09:05');
    expect(formatHhMm(1440)).toBe('00:00'); // stepping past 23:30 + 30
    expect(formatHhMm(-30)).toBe('23:30'); // stepping below 00:00
  });
});
