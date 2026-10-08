import type { YearRange } from './use-year-story';
import { OLDEST_YEAR } from './year-model';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The full-screen story's params (`yearHref`, `src/lib/paths.ts`) back: a year the
 * server would refuse (not `YYYY`, before 2000) is this year, a card that isn't a whole
 * number is the first. */
export function parseYearParams(params: {
  year?: string | string[];
  connection?: string | string[];
  card?: string | string[];
}): { range: YearRange; connection?: string; card: number } {
  const year = first(params.year);
  const card = Number(first(params.card));
  const valid = !!year && /^\d{4}$/.test(year) && Number(year) >= OLDEST_YEAR;
  return {
    range: valid ? (year as `${number}`) : 'year',
    connection: first(params.connection) || undefined,
    card: Number.isInteger(card) && card > 0 ? card : 0,
  };
}
