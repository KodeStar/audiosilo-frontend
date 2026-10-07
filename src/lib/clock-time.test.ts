import { formatClockTime } from './clock-time';

describe('formatClockTime', () => {
  it('formats an instant as its local time of day', () => {
    const at = new Date(2026, 9, 7, 22, 49, 31).getTime();
    expect(formatClockTime(at)).toMatch(/22:49|10:49/);
  });

  it('pads the minutes', () => {
    const at = new Date(2026, 9, 7, 7, 5).getTime();
    expect(formatClockTime(at)).toMatch(/0?7:05/);
  });
});
