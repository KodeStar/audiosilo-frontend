import {
  addDays,
  dailyPace,
  estimatedFinish,
  goalProgress,
  lastSevenDays,
  listeningStreak,
  serverToday,
  weekdayOf,
} from './listening';

const days = (from: string, listened: number[]) =>
  listened.map((s, i) => ({ date: addDays(from, i), listened: s }));

describe('serverToday', () => {
  it('reads the date in the server zone, not UTC', () => {
    // 23:30 UTC is already the next day two hours east.
    expect(serverToday({ to: '2026-10-05T23:30:00Z', utc_offset: 120 })).toBe('2026-10-06');
    expect(serverToday({ to: '2026-10-06T01:00:00Z', utc_offset: -300 })).toBe('2026-10-05');
  });
  it('is null for a date it cannot read', () => {
    expect(serverToday({ to: 'soon', utc_offset: 0 })).toBeNull();
  });
});

describe('dates', () => {
  it('moves across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('counts weekdays from Monday', () => {
    expect(weekdayOf('2026-10-05')).toBe(0); // a Monday
    expect(weekdayOf('2026-10-11')).toBe(6);
  });
});

describe('listeningStreak', () => {
  it('counts back from today', () => {
    expect(listeningStreak(days('2026-10-01', [0, 60, 60, 60]), '2026-10-04')).toBe(3);
  });
  it('keeps yesterday’s streak while today has nothing yet', () => {
    expect(listeningStreak(days('2026-10-01', [60, 60, 60, 0]), '2026-10-04')).toBe(3);
  });
  it('is broken by a missed day', () => {
    expect(listeningStreak(days('2026-10-01', [60, 60, 0, 0]), '2026-10-04')).toBe(0);
    expect(listeningStreak(days('2026-10-01', [60, 0, 60, 60]), '2026-10-04')).toBe(2);
  });
  it('ends where the period does', () => {
    expect(listeningStreak(days('2026-10-03', [60, 60]), '2026-10-04')).toBe(2);
  });
});

describe('lastSevenDays', () => {
  it('is the seven days up to today, oldest first, zeros filled', () => {
    const week = lastSevenDays(days('2026-10-03', [100, 200]), '2026-10-04');
    expect(week.map((d) => d.date)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    expect(week.map((d) => d.listened)).toEqual([0, 0, 0, 0, 0, 100, 200]);
    expect(week.map((d) => d.today)).toEqual([false, false, false, false, false, false, true]);
    expect(week[0].weekday).toBe(0); // 28 Sep 2026 is a Monday
  });
});

describe('dailyPace', () => {
  it('averages over every day of the period', () => {
    expect(dailyPace(days('2026-10-01', [3600, 0, 3600, 3600, 0, 0]))).toBe(1800);
  });
  it('has no pace from too little listening', () => {
    expect(dailyPace([])).toBeNull();
    expect(dailyPace(days('2026-10-01', [3600, 3600, 0]))).toBeNull(); // two days
    expect(dailyPace(days('2026-10-01', [600, 600, 600]))).toBeNull(); // half an hour
  });
});

describe('estimatedFinish', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  it('counts today as the first day', () => {
    expect(estimatedFinish(1800, 3600, now).toISOString().slice(0, 10)).toBe('2026-10-05');
    expect(
      estimatedFinish(3600 * 3, 3600, now)
        .toISOString()
        .slice(0, 10),
    ).toBe('2026-10-07');
  });
});

describe('goalProgress', () => {
  const status = (books: number | null, finished: number) => ({
    goal: books ? { books_per_year: books, updated_at: '' } : null,
    year: '2026',
    finished,
  });
  it('is null without a goal', () => {
    expect(goalProgress(status(null, 3), '2026-10-05')).toBeNull();
  });
  it('spreads what is left over the rest of the year', () => {
    // 5 Oct to 31 Dec is 88 days, for 21 books.
    expect(goalProgress(status(24, 3), '2026-10-05')).toEqual({
      goal: 24,
      finished: 3,
      fraction: 0.125,
      remaining: 21,
      everyDays: 4,
    });
  });
  it('is never more often than daily, and done once met', () => {
    expect(goalProgress(status(100, 0), '2026-12-30')?.everyDays).toBe(1);
    expect(goalProgress(status(2, 5), '2026-10-05')).toMatchObject({
      fraction: 1,
      remaining: 0,
      everyDays: null,
    });
  });
});
