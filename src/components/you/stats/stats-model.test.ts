import type { ListeningDay } from '@/api/types';
import { addDays } from '@/components/home/listening';

import {
  BARS_FRAME,
  CALENDAR_WEEKS,
  barAt,
  calendarCellAt,
  calendarGrid,
  clockSummary,
  columnWidth,
  dailyAverage,
  daysWithListening,
  hourTotals,
  levelScale,
  libraryForName,
  longestStreak,
  nextGoal,
  niceAxis,
  petalAt,
  petalPath,
  rankRows,
  statsColumns,
  statsServerChoice,
  suggestedGoal,
  weekComparison,
  weeklyTotals,
} from './stats-model';

/** `n` days ending `end`, oldest first, each listened `f(i)` seconds (i = 0 oldest). */
function run(end: string, n: number, f: (i: number) => number): ListeningDay[] {
  return Array.from({ length: n }, (_, i) => ({ date: addDays(end, i - n + 1), listened: f(i) }));
}

const TODAY = '2026-10-08'; // a Thursday

describe('weeklyTotals', () => {
  it('sums rolling seven-day windows ending today, oldest first', () => {
    const days = run(TODAY, 21, (i) => (i < 7 ? 60 : i < 14 ? 120 : 600));
    expect(weeklyTotals(days, TODAY, 3)).toEqual([420, 840, 4200]);
  });

  it('counts days outside the response as none', () => {
    expect(weeklyTotals(run(TODAY, 3, () => 100), TODAY, 2)).toEqual([0, 300]);
  });

  it('compares this week with last week', () => {
    const days = run(TODAY, 14, (i) => (i < 7 ? 3600 : 1800));
    expect(weekComparison(days, TODAY)).toEqual({
      thisWeek: 7 * 1800,
      lastWeek: 7 * 3600,
      delta: -7 * 1800,
    });
  });
});

describe('streaks and averages', () => {
  it('finds the longest run of listening days', () => {
    const pattern = [1, 1, 0, 1, 1, 1, 0, 1];
    expect(longestStreak(run(TODAY, pattern.length, (i) => pattern[i] * 60))).toBe(3);
  });

  it('breaks a run on a day missing from the list', () => {
    const days = [
      { date: '2026-01-01', listened: 60 },
      { date: '2026-01-02', listened: 60 },
      { date: '2026-01-04', listened: 60 },
    ];
    expect(longestStreak(days)).toBe(2);
    expect(longestStreak([])).toBe(0);
  });

  it('averages over every day, zeros included', () => {
    expect(dailyAverage(run(TODAY, 4, (i) => (i === 0 ? 400 : 0)))).toBe(100);
    expect(dailyAverage([])).toBe(0);
    expect(daysWithListening(run(TODAY, 5, (i) => i % 2))).toBe(2);
  });
});

describe('calendarGrid', () => {
  it('lays 53 Monday-first weeks out, ending with the week of today', () => {
    const days = run(TODAY, 366, () => 60);
    const grid = calendarGrid(days, TODAY);
    expect(grid.columns).toHaveLength(CALENDAR_WEEKS);
    const last = grid.columns[CALENDAR_WEEKS - 1];
    expect(last[0]?.date).toBe('2026-10-05'); // Monday
    expect(last[3]).toMatchObject({ date: TODAY, today: true });
    // The rest of this week is still to come.
    expect(last.slice(4)).toEqual([null, null, null]);
    expect(grid.columns.flat().filter((c) => c?.today)).toHaveLength(1);
  });

  it('leaves the days before the period empty', () => {
    const grid = calendarGrid(run(TODAY, 10, () => 60), TODAY);
    const cells = grid.columns.flat().filter(Boolean);
    expect(cells).toHaveLength(10);
    expect(cells[0]?.date).toBe(addDays(TODAY, -9));
  });

  it('labels each month at the column holding its first day, three columns apart', () => {
    const grid = calendarGrid(run(TODAY, 366, () => 0), TODAY);
    const oct = grid.months.find((m) => m.month === 9 && m.column > 40);
    const firstOct = grid.columns[oct!.column].some((c) => c?.date === '2026-10-01');
    expect(firstOct).toBe(true);
    for (let i = 1; i < grid.months.length; i++) {
      expect(grid.months[i].column - grid.months[i - 1].column).toBeGreaterThanOrEqual(3);
    }
    expect(grid.months.every((m) => m.column < CALENDAR_WEEKS - 1)).toBe(true);
  });

  it('finds the cell under a point', () => {
    const grid = calendarGrid(run(TODAY, 366, () => 60), TODAY);
    // Cells 10 wide with a 2 gap: column 52, row 3 is today.
    expect(calendarCellAt(grid, 52 * 12 + 4, 3 * 12 + 4, 10, 2)?.date).toBe(TODAY);
    expect(calendarCellAt(grid, 52 * 12 + 4, 5 * 12 + 4, 10, 2)).toBeNull(); // the future
    expect(calendarCellAt(grid, -4, 4, 10, 2)).toBeNull();
    expect(calendarCellAt(grid, 4, 8 * 12, 10, 2)).toBeNull();
  });
});

describe('levelScale', () => {
  it('grades days 1-5 against the heavy days, 0 for none', () => {
    const days = run(TODAY, 20, (i) => (i + 1) * 600); // 10m ... 200m
    const level = levelScale(days);
    expect(level(0)).toBe(0);
    expect(level(1)).toBe(1);
    expect(level(20 * 600)).toBe(5);
    expect(level(10 * 600)).toBe(3);
  });

  it("keeps one marathon from washing out every other day", () => {
    const days = run(TODAY, 40, (i) => (i === 0 ? 20 * 3600 : 3600));
    expect(levelScale(days)(3600)).toBe(5);
  });

  it('reads nothing at all as level 0', () => {
    expect(levelScale([])(500)).toBe(0);
  });
});

describe('the listening clock', () => {
  const grid = (hours: Record<number, number>) =>
    Array.from({ length: 7 }, (_, w) =>
      Array.from({ length: 24 }, (_, h) => (w === 0 ? (hours[h] ?? 0) : 0)),
    );

  it('sums the weekdays per hour', () => {
    const hw = Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, h) => h));
    expect(hourTotals(hw)[5]).toBe(35);
  });

  it('names the busiest hour and the peak windows, biggest first', () => {
    const s = clockSummary(grid({ 7: 800, 8: 780, 12: 100, 22: 1000 }));
    expect(s.busiest).toBe(22);
    expect(s.peak[7] && s.peak[8] && s.peak[22]).toBe(true);
    expect(s.peak[12]).toBe(false);
    expect(s.windows).toEqual([
      { from: 7, to: 9 },
      { from: 22, to: 23 },
    ]);
  });

  it('joins a peak across midnight', () => {
    const s = clockSummary(grid({ 23: 1000, 0: 900, 10: 10 }));
    expect(s.windows).toEqual([{ from: 23, to: 1 }]);
  });

  it('has no busiest hour without listening', () => {
    const s = clockSummary(grid({}));
    expect(s.busiest).toBeNull();
    expect(s.windows).toEqual([]);
  });

  it('finds the petal under a point, 00 at the top, clockwise', () => {
    const size = 200;
    expect(petalAt(size, 102, 20)).toBe(0); // just right of top
    expect(petalAt(size, 180, 102)).toBe(6); // right
    expect(petalAt(size, 98, 180)).toBe(12); // bottom, just left
    expect(petalAt(size, 20, 98)).toBe(18); // left, just above
    expect(petalAt(size, 20, 102)).toBe(17); // left, just below
    expect(petalAt(size, 100, 100)).toBeNull(); // the middle
    expect(petalAt(size, 0, 0)).toBeNull(); // outside
  });

  it('draws a petal as a closed path', () => {
    expect(petalPath(200, 3, 5, 10)).toMatch(/^M.*Z$/);
  });
});

describe('hours per week', () => {
  it('rounds the axis to at most four steps', () => {
    expect(niceAxis(15 * 3600)).toEqual({
      top: 16 * 3600,
      ticks: [0, 4 * 3600, 8 * 3600, 12 * 3600, 16 * 3600],
    });
    expect(niceAxis(0).top).toBe(900);
    expect(niceAxis(50 * 60).ticks).toEqual([0, 900, 1800, 2700, 3600]);
  });

  it('finds the bar under a point', () => {
    const width = BARS_FRAME.left + 12 * 20;
    expect(barAt(width, BARS_FRAME.left + 5)).toBe(0);
    expect(barAt(width, BARS_FRAME.left + 11 * 20 + 3)).toBe(11);
    expect(barAt(width, width + 50)).toBe(11);
    expect(barAt(width, 3)).toBeNull();
  });
});

describe('rank lists', () => {
  it('ranks the top names against the first', () => {
    const rows = rankRows([
      { name: 'A', listened: 200, books: 2 },
      { name: ' ', listened: 150, books: 1 },
      { name: 'B', listened: 50, books: 1 },
      { name: 'C', listened: 0, books: 1 },
    ]);
    expect(rows.map((r) => [r.rank, r.name, r.fraction])).toEqual([
      [1, 'A', 1],
      [2, 'B', 0.25],
    ]);
  });

  it("opens an author's page in a library of their books, else the year's main one", () => {
    const stats = {
      top_books: [
        { library_id: 2, path: 'a', title: 'A', author: 'Ann', listened: 1 },
        { library_id: 1, path: 'b', title: 'B', author: 'Bo', listened: 1 },
      ],
      finished_books: [
        { library_id: 1, path: 'c', title: 'C', author: 'Cy', finished_at: '' },
      ],
    };
    expect(libraryForName(stats, 'author', 'Ann')).toBe(2);
    expect(libraryForName(stats, 'narrator', 'Ann')).toBe(1);
    expect(libraryForName({ top_books: [], finished_books: [] }, 'series', 'X')).toBeNull();
  });
});

describe('the yearly goal', () => {
  it('steps by ones to 12, twos to 40, then fives, both ways', () => {
    expect(nextGoal(11, 1)).toBe(12);
    expect(nextGoal(12, 1)).toBe(14);
    expect(nextGoal(14, -1)).toBe(12);
    expect(nextGoal(40, 1)).toBe(45);
    expect(nextGoal(45, -1)).toBe(40);
    expect(nextGoal(41, 1)).toBe(45);
    expect(nextGoal(41, -1)).toBe(40);
  });

  it('stays within 1-1000', () => {
    expect(nextGoal(1, -1)).toBe(1);
    expect(nextGoal(1000, 1)).toBe(1000);
  });

  it('suggests this year carried to December, at least a book a month', () => {
    expect(suggestedGoal(0, '2026-01-01')).toBe(12);
    // 41 books by 8 October: about 53 by the end of the year.
    expect(suggestedGoal(41, TODAY)).toBe(55);
    expect(suggestedGoal(20, '2026-12-31')).toBe(22);
  });
});

describe('layout and servers', () => {
  it('fits columns to the measured width', () => {
    expect(statsColumns(360)).toEqual({ tiles: 2, charts: 1, ranks: 1 });
    expect(statsColumns(760)).toEqual({ tiles: 2, charts: 2, ranks: 2 });
    expect(statsColumns(1100)).toEqual({ tiles: 4, charts: 2, ranks: 3 });
    expect(columnWidth(100, 2, 10)).toBe(45);
  });

  const ids = ['a', 'b', 'c'];
  it('shows the default server, with a picker only when two keep stats', () => {
    expect(
      statsServerChoice({
        connectionIds: ids,
        userStats: { a: true, b: false, c: undefined },
        defaultId: 'a',
        picked: null,
      }),
    ).toEqual({ cid: 'a', choices: ['a'] });
    expect(
      statsServerChoice({
        connectionIds: ids,
        userStats: { a: true, b: true },
        defaultId: 'a',
        picked: 'b',
      }),
    ).toEqual({ cid: 'b', choices: ['a', 'b'] });
  });

  it('moves off a default without stats to a server that keeps them', () => {
    expect(
      statsServerChoice({
        connectionIds: ids,
        userStats: { a: false, b: true },
        defaultId: 'a',
        picked: null,
      }).cid,
    ).toBe('b');
    // Still loading: wait on the default.
    expect(
      statsServerChoice({ connectionIds: ids, userStats: { b: true }, defaultId: 'a', picked: null })
        .cid,
    ).toBe('a');
    // None keep stats: the default explains it.
    expect(
      statsServerChoice({ connectionIds: ids, userStats: { a: false }, defaultId: 'a', picked: 'c' })
        .cid,
    ).toBe('a');
  });

  it('drops a pick that no longer keeps stats', () => {
    expect(
      statsServerChoice({
        connectionIds: ['a'],
        userStats: { a: true },
        defaultId: 'a',
        picked: 'gone',
      }).cid,
    ).toBe('a');
  });
});
