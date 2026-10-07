import { durationParts, formatHour, formatServerShortDay } from './stats-format';

describe('stats formatting', () => {
  it('reads a server day as that calendar day', () => {
    expect(formatServerShortDay('2026-10-03', 'en-GB')).toBe('Sat 3 Oct');
  });

  it("writes an hour on the reader's clock", () => {
    expect(formatHour(22, 'en-GB')).toBe('22:00');
    expect(formatHour(7, 'en-US')).toBe('7:00 AM');
  });

  it('splits a duration into figures and units', () => {
    expect(durationParts(11 * 3600 + 6 * 60)).toEqual([
      { n: '11', unit: 'h' },
      { n: '6', unit: 'm' },
    ]);
    expect(durationParts(0)).toEqual([{ n: '0', unit: 'm' }]);
  });
});
