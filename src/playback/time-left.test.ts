import i18n from '@/i18n';

import { bookSpeed, formatTimeLeft, isNormalSpeed, timeLeft, timeLeftLabel } from './time-left';

const t = i18n.t.bind(i18n);

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('bookSpeed', () => {
  it("uses the book's own saved speed", () => {
    expect(bookSpeed(1.25, 1)).toBe(1.25);
  });

  it('falls back to the default speed setting, then to 1', () => {
    expect(bookSpeed(undefined, 1.5)).toBe(1.5);
    expect(bookSpeed(0, 1.5)).toBe(1.5);
    expect(bookSpeed(null, 0)).toBe(1);
  });
});

describe('timeLeft', () => {
  it('is wall-clock time at the speed', () => {
    expect(timeLeft(600, 7800, 2)).toEqual({ seconds: 3600, speed: 2 });
  });

  it('is null without a timeline', () => {
    expect(timeLeft(10, 0, 1)).toBeNull();
    expect(timeLeft(10, -1, 1)).toBeNull();
  });

  it('never goes negative, and treats a bad speed as 1x', () => {
    expect(timeLeft(9000, 7800, 1)).toEqual({ seconds: 0, speed: 1 });
    expect(timeLeft(0, 60, 0)).toEqual({ seconds: 60, speed: 1 });
  });
});

describe('isNormalSpeed', () => {
  it('reads 1x at two decimals, as the speed is shown', () => {
    expect(isNormalSpeed(1)).toBe(true);
    expect(isNormalSpeed(1.004)).toBe(true);
    expect(isNormalSpeed(1.05)).toBe(false);
    expect(isNormalSpeed(0.95)).toBe(false);
  });
});

describe('formatTimeLeft', () => {
  it('says the speed when it is not 1x', () => {
    // (22h 27m) x 1.25 of audio left.
    const seconds = (22 * 3600 + 27 * 60) * 1.25;
    expect(formatTimeLeft(t, timeLeft(0, seconds, 1.25))).toBe('22h 27m left at 1.25×');
  });

  it('says nothing about speed at 1x', () => {
    expect(formatTimeLeft(t, timeLeft(0, 2700, 1))).toBe('45m left');
  });

  it('formats hours, minutes and seconds like the rest of the app', () => {
    expect(formatTimeLeft(t, timeLeft(0, 3 * 3600, 1))).toBe('3h left');
    expect(formatTimeLeft(t, timeLeft(0, 3 * 3600 + 60, 1))).toBe('3h 1m left');
    expect(formatTimeLeft(t, timeLeft(0, 30, 1))).toBe('30s left');
    // Rounded to the second first: 59.6 s reads as a minute.
    expect(formatTimeLeft(t, timeLeft(0, 59.6, 1))).toBe('1m left');
  });

  it('drops trailing zeros from the speed', () => {
    expect(formatTimeLeft(t, timeLeft(0, 3600, 1.5))).toBe('40m left at 1.5×');
    expect(formatTimeLeft(t, timeLeft(0, 3600, 2))).toBe('30m left at 2×');
  });

  it('is empty when nothing is left or the timeline is unknown', () => {
    expect(formatTimeLeft(t, null)).toBe('');
    expect(formatTimeLeft(t, timeLeft(100, 100, 1.25))).toBe('');
  });

  it.each([
    ['de', 'noch 45m bei 1.25×', 'noch 45m'],
    ['fr', '45m restantes à 1.25×', '45m restantes'],
    ['es', 'quedan 45m a 1.25×', 'quedan 45m'],
    ['it', 'mancano 45m a 1.25×', 'mancano 45m'],
    ['pt', 'faltam 45m a 1.25×', 'faltam 45m'],
  ])('is translated in %s', async (lang, atSpeed, normal) => {
    await i18n.changeLanguage(lang);
    expect(formatTimeLeft(t, timeLeft(0, 2700 * 1.25, 1.25))).toBe(atSpeed);
    expect(formatTimeLeft(t, timeLeft(0, 2700, 1))).toBe(normal);
  });
});

describe('timeLeftLabel', () => {
  it('labels a time-left figure with the speed, or plainly at 1x', () => {
    expect(timeLeftLabel(t, 1.25)).toBe('left at 1.25×');
    expect(timeLeftLabel(t, 1)).toBe('left');
  });
});
