import type { ListeningDay, UserStats } from '@/api/types';

/** Every day of `year` (server time), with `listened` seconds from `at(date, i)`. */
export function yearDays(
  year: number,
  at: (date: string, i: number) => number,
  through = `${year}-12-31`,
): ListeningDay[] {
  const out: ListeningDay[] = [];
  for (let t = Date.UTC(year, 0, 1); ; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push({ date, listened: at(date, out.length) });
    if (date >= through) break;
  }
  return out;
}

const zeros = () => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

/** A year of stats for the Year in listening tests: a rich one by default. */
export function yearStats(over: Partial<UserStats> = {}): UserStats {
  const hourWeekday = zeros();
  hourWeekday[0][22] = 7200;
  hourWeekday[3][22] = 3600;
  hourWeekday[2][7] = 5400;
  return {
    range: '2026',
    from: '2026-01-01T00:00:00Z',
    to: '2026-10-08T12:00:00Z',
    timezone: 'UTC',
    utc_offset: 0,
    totals: { listened: 412 * 3600, sessions: 380, books: 52, finished: 41 },
    previous: { listened: 300 * 3600, sessions: 200, books: 30, finished: 20 },
    estimated: 0,
    // Listening on the first 38 days, then every other day.
    days: yearDays(2026, (_, i) => (i < 38 || (i > 38 && i % 2 === 0) ? 3600 : 0), '2026-10-08'),
    hour_weekday: hourWeekday,
    top_books: [
      {
        library_id: 1,
        path: 'Sanderson/The Way of Kings',
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
        listened: 36 * 3600,
      },
      {
        library_id: 1,
        path: 'Weir/Project Hail Mary',
        title: 'Project Hail Mary',
        author: 'Andy Weir',
        listened: 16 * 3600,
      },
    ],
    top_authors: [{ name: 'Brandon Sanderson', listened: 90 * 3600, books: 5 }],
    top_narrators: [
      { name: 'Michael Kramer', listened: 61 * 3600, books: 4 },
      { name: 'Jeff Hays', listened: 45 * 3600, books: 3 },
      { name: 'Ray Porter', listened: 28 * 3600, books: 2 },
    ],
    top_series: [{ name: 'The Stormlight Archive', listened: 70 * 3600, books: 3 }],
    finished_books: [
      {
        library_id: 1,
        path: 'Weir/Project Hail Mary',
        title: 'Project Hail Mary',
        author: 'Andy Weir',
        finished_at: '2026-09-30T20:00:00Z',
      },
      {
        library_id: 1,
        path: 'Sanderson/The Way of Kings',
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
        finished_at: '2026-03-02T20:00:00Z',
      },
    ],
    playback: [],
    clients: [],
    ...over,
  };
}
