import { yearDays, yearStats } from './year-fixture';
import {
  buildYearCards,
  busiestHour,
  dayPart,
  hasData,
  hourTotals,
  longestStreak,
  MAX_TOWER,
  roundHours,
  shareFileName,
  storyCovers,
  STREAK_GRID_DAYS,
  streakGrid,
  towerSpines,
  type YearCard,
  yearHasStory,
} from './year-model';

const kinds = (cards: YearCard[]) => cards.map((c) => c.kind);
const card = <K extends YearCard['kind']>(cards: YearCard[], kind: K) =>
  cards.find((c) => c.kind === kind) as Extract<YearCard, { kind: K }> | undefined;

describe('buildYearCards', () => {
  it('tells a full year in order, ending on the summary', () => {
    const cards = buildYearCards({ stats: yearStats(), current: true, currentStreak: 3, goal: 50 });
    expect(kinds(cards)).toEqual([
      'hours',
      'books',
      'book',
      'voice',
      'clock',
      'streak',
      'people',
      'summary',
    ]);
  });

  it('leaves out every card it has no data for, never an empty one', () => {
    const cards = buildYearCards({
      stats: yearStats({
        totals: { listened: 5 * 3600, sessions: 4, books: 1, finished: 0 },
        days: yearDays(2026, (_, i) => (i === 3 ? 3600 : 0), '2026-10-08'),
        hour_weekday: [],
        top_books: [],
        top_authors: [{ name: '', listened: 3600, books: 1 }],
        top_narrators: [{ name: '  ', listened: 3600, books: 1 }],
        top_series: [],
        finished_books: [],
      }),
      current: true,
      currentStreak: 0,
      goal: null,
    });
    expect(kinds(cards)).toEqual(['hours', 'summary']);
  });

  it('has no story for a year with too little listening (the calm empty state)', () => {
    const stats = yearStats({ totals: { listened: 1200, sessions: 2, books: 1, finished: 0 } });
    expect(yearHasStory(stats)).toBe(false);
    expect(buildYearCards({ stats, current: false, currentStreak: null, goal: null })).toEqual([]);
  });

  it('tells a year of finished books even without an hour of recorded listening', () => {
    const stats = yearStats({ totals: { listened: 600, sessions: 1, books: 2, finished: 2 } });
    const cards = buildYearCards({ stats, current: false, currentStreak: null, goal: null });
    expect(kinds(cards)).not.toContain('hours');
    expect(kinds(cards)).toContain('books');
  });

  it('counts whole days and keeps the estimated share for the hours card', () => {
    const cards = buildYearCards({
      stats: yearStats({ estimated: 5400 }),
      current: false,
      currentStreak: null,
      goal: null,
    });
    expect(card(cards, 'hours')).toMatchObject({ wholeDays: 17, estimated: 5400, sessions: 380 });
  });

  it('only puts a goal and a running streak on this year', () => {
    const past = buildYearCards({ stats: yearStats(), current: false, currentStreak: 9, goal: 50 });
    expect(card(past, 'books')?.goal).toBeNull();
    expect(card(past, 'streak')?.current).toBeNull();
    const now = buildYearCards({ stats: yearStats(), current: true, currentStreak: 9, goal: 50 });
    expect(card(now, 'books')?.goal).toBe(50);
    expect(card(now, 'streak')?.current).toBe(9);
  });

  it('names the voice of the year and up to two runners up', () => {
    const voice = card(
      buildYearCards({ stats: yearStats(), current: false, currentStreak: null, goal: null }),
      'voice',
    );
    expect(voice?.narrator.name).toBe('Michael Kramer');
    expect(voice?.runnersUp.map((n) => n.name)).toEqual(['Jeff Hays', 'Ray Porter']);
  });

  it('finds the busiest hour from every weekday summed', () => {
    const clock = card(
      buildYearCards({ stats: yearStats(), current: false, currentStreak: null, goal: null }),
      'clock',
    );
    expect(clock).toMatchObject({ peak: 22, part: 'night' });
    expect(clock?.hours[22]).toBe(10800);
  });

  it('shows the weeks up to today for a streak still running, else the streak’s own', () => {
    const stats = yearStats();
    const running = card(
      buildYearCards({ stats, current: true, currentStreak: 1, goal: null }),
      'streak',
    );
    expect(running?.longest).toBe(38);
    expect(running?.grid).toHaveLength(STREAK_GRID_DAYS);
    // The last square is today (2026-10-08, day 280: listened, an even index).
    expect(running?.grid.at(-1)).toBe(stats.days.at(-1)?.listened);
    const old = card(
      buildYearCards({ stats, current: false, currentStreak: null, goal: null }),
      'streak',
    );
    // The 38-day streak ended on 7 Feb: the grid is the year's first 38 days.
    expect(old?.grid).toHaveLength(38);
    expect(old?.grid.every((s) => s > 0)).toBe(true);
  });
});

describe('streaks', () => {
  it('finds the longest run of listening days and where it ended', () => {
    const days = yearDays(2026, (_, i) => ([0, 1, 4, 5, 6, 9].includes(i) ? 60 : 0), '2026-01-12');
    expect(longestStreak(days)).toEqual({ length: 3, end: '2026-01-07' });
  });

  it('breaks a streak at a gap in the dates, not only at a zero day', () => {
    const days = [
      { date: '2026-01-01', listened: 60 },
      { date: '2026-01-02', listened: 60 },
      { date: '2026-01-05', listened: 60 },
    ];
    expect(longestStreak(days)).toEqual({ length: 2, end: '2026-01-02' });
  });

  it('is nothing without listening', () => {
    expect(longestStreak(yearDays(2026, () => 0, '2026-01-31'))).toEqual({ length: 0, end: null });
  });

  it('cuts the grid to twelve weeks ending at the given day', () => {
    const days = yearDays(2026, (_, i) => i, '2026-12-31');
    const grid = streakGrid(days, '2026-06-30');
    expect(grid).toHaveLength(STREAK_GRID_DAYS);
    expect(grid.at(-1)).toBe(180); // 30 June is day 180 (0-based)
    expect(streakGrid(days, null).at(-1)).toBe(364);
    expect(streakGrid([], null)).toEqual([]);
  });
});

describe('the listening clock', () => {
  it('sums the weekdays per hour and tolerates short rows', () => {
    const hours = hourTotals([[1, 2], [3], []]);
    expect(hours).toHaveLength(24);
    expect(hours.slice(0, 3)).toEqual([4, 2, 0]);
    expect(hourTotals(undefined)).toEqual(Array.from({ length: 24 }, () => 0));
  });

  it('picks the earliest of the busiest hours, or none', () => {
    const hours = Array.from({ length: 24 }, () => 0);
    hours[7] = 5;
    hours[21] = 5;
    expect(busiestHour(hours)).toBe(7);
    expect(busiestHour(Array.from({ length: 24 }, () => 0))).toBeNull();
  });

  it('names the part of the day', () => {
    expect([5, 11, 12, 16, 17, 21, 22, 4].map(dayPart)).toEqual([
      'morning',
      'morning',
      'afternoon',
      'afternoon',
      'evening',
      'evening',
      'night',
      'night',
    ]);
  });
});

describe('books', () => {
  it('stacks the newest finished book on top, at most a tower’s worth', () => {
    const finished = Array.from({ length: 120 }, (_, i) => ({
      library_id: 1,
      path: `b${i}`,
      title: `Book ${i}`,
      author: 'A',
      finished_at: '',
    }));
    const spines = towerSpines(finished);
    expect(spines).toHaveLength(MAX_TOWER);
    // Drawn bottom up: the last spine (top of the stack) is the newest, the wire's first.
    expect(spines.at(-1)?.title).toBe('Book 0');
    expect(spines.every((s) => s.width >= 0.55 && s.width <= 1)).toBe(true);
    // The same title always gets the same spine.
    expect(towerSpines(finished)[3]).toEqual(spines[3]);
  });

  it('puts each book once on the summary, finished first', () => {
    const covers = storyCovers(yearStats());
    expect(covers.map((c) => c.title)).toEqual(['Project Hail Mary', 'The Way of Kings']);
    expect(storyCovers(yearStats(), 1)).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('rounds hours and names a shared card’s file', () => {
    expect(roundHours(412.6 * 3600)).toBe(413);
    expect(roundHours(-5)).toBe(0);
    expect(shareFileName('2026', 0, 'hours')).toBe('audiosilo-2026-01-hours.png');
    expect(shareFileName('2025', 11, 'summary')).toBe('audiosilo-2025-12-summary.png');
  });

  it('counts a year as having data on the story’s own bar', () => {
    expect(hasData({ listened: 3600, finished: 0 })).toBe(true);
    expect(hasData({ listened: 10, finished: 1 })).toBe(true);
    expect(hasData({ listened: 3599, finished: 0 })).toBe(false);
  });
});
