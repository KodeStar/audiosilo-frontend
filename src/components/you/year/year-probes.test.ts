import { findStoryYears } from './year-probes';

const totals = (listened: number, finished = 0) => ({ listened, sessions: 1, books: 1, finished });

/** Stats per year from `listened` hours per year (absent: none). */
function server(hours: Record<number, number>) {
  const asked: number[] = [];
  const statsOf = async (year: number) => {
    asked.push(year);
    return {
      totals: totals((hours[year] ?? 0) * 3600),
      previous: totals((hours[year - 1] ?? 0) * 3600),
    };
  };
  return { asked, statsOf };
}

describe('findStoryYears', () => {
  it('walks back while a year or the one before it has a story', () => {
    // 2023 is quiet but 2022 has a story: the search goes on past it.
    const s = server({ 2025: 40, 2024: 12, 2022: 3 });
    return findStoryYears(2026, s.statsOf).then((years) => {
      expect(years).toEqual([2025, 2024, 2022]);
      // Stopped at 2021 (quiet, and 2020 too).
      expect(s.asked).toEqual([2025, 2024, 2023, 2022, 2021]);
    });
  });

  it('counts a year with a finished book, and stops at the first quiet pair', async () => {
    const s = server({});
    expect(await findStoryYears(2026, s.statsOf)).toEqual([]);
    expect(s.asked).toEqual([2025]);
    const finished = async (year: number) => ({
      totals: totals(0, year === 2025 ? 1 : 0),
      previous: totals(0),
    });
    expect(await findStoryYears(2026, finished)).toEqual([2025]);
  });

  it("keeps what it found when a year can't be read", async () => {
    const statsOf = async (year: number) => {
      if (year === 2024) throw new Error('offline');
      return { totals: totals(7200), previous: totals(7200) };
    };
    expect(await findStoryYears(2026, statsOf)).toEqual([2025]);
  });

  it('asks no further back than 25 years or the oldest year the server takes', async () => {
    const always = server(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [1990 + i, 9])));
    expect(await findStoryYears(2049, always.statsOf)).toHaveLength(25);
    const early = server({ 2000: 9, 2001: 9 });
    expect(await findStoryYears(2002, early.statsOf)).toEqual([2001, 2000]);
    expect(early.asked).toEqual([2001, 2000]);
  });
});
