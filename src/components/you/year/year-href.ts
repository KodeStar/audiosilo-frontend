import type { Href } from 'expo-router';

import type { YearRange } from './use-year-story';
import { OLDEST_YEAR } from './year-model';

/** What the full-screen story (`/year`) shows: a year, a server, a card to start on. */
export type YearStoryParams = {
  /** A past year; absent for this year. */
  year?: number;
  /** A server other than the default. */
  connection?: string;
  /** The card to start on (0-based). */
  card?: number;
};

/**
 * The phone's full-screen Year in listening story, a root modal like the player: `/year`
 * with `?year=YYYY` (absent: this year), `?connection=` (absent: the default server) and
 * `?card=` (absent: the first). Local to the story (`src/lib/paths.ts` belongs to the
 * shell); open it with `router.push`, it never leads into the shell.
 */
export function yearHref(params: YearStoryParams = {}): Href {
  return {
    pathname: '/year',
    params: {
      ...(params.year !== undefined ? { year: String(params.year) } : {}),
      ...(params.connection ? { connection: params.connection } : {}),
      ...(params.card ? { card: String(params.card) } : {}),
    },
  } as Href;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The route's params back: a year the server would refuse (not `YYYY`, before 2000) is
 * this year, a card that isn't a whole number is the first. */
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
