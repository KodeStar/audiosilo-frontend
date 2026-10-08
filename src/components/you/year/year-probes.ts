import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';

import { myStatsQuery, qk, useCapability } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import type { UserStats } from '@/api/types';

import { OLDEST_YEAR, yearHasStory } from './year-model';

/** How many years back the picker looks at most. */
const MAX_YEARS_BACK = 25;

/**
 * The past years with a story, newest first, asking one year at a time from the year
 * before `current` back (`statsOf`): on while a year has a story or the year before it
 * does (its `previous` totals), so a single quiet year doesn't hide the ones before it.
 * Two quiet years in a row, a year that can't be read, `MAX_YEARS_BACK` or the server's
 * oldest year end the search.
 */
export async function findStoryYears(
  current: number,
  statsOf: (year: number) => Promise<Pick<UserStats, 'totals' | 'previous'>>,
): Promise<number[]> {
  const years: number[] = [];
  for (let year = current - 1; year >= OLDEST_YEAR && current - year <= MAX_YEARS_BACK; year--) {
    const stats = await statsOf(year).catch(() => null);
    if (!stats) break;
    const has = yearHasStory(stats.totals);
    if (has) years.push(year);
    if (!has && !yearHasStory(stats.previous)) break;
  }
  return years;
}

/**
 * The past years with a story on a server, newest first, for the year picker. The wire
 * has no "which years have data", so it asks each year with the stats route the story
 * itself reads (`/me/stats?range=YYYY`, the same cache entry, so picking a year shows at
 * once). A past year never changes: its stats and the list are kept for the session
 * (`staleTime: Infinity`). `current` is this year (`YYYY`, server time), unknown until
 * the story's own stats arrive.
 */
export function useStoryYears(cid: string, current: number | null): number[] {
  const qc = useQueryClient();
  const api = useOptionalApi(cid);
  const supported = useCapability('user_stats', cid) === true;
  const years = useQuery({
    queryKey: qk.storyYears(cid, current ?? 0),
    queryFn:
      supported && api && current !== null
        ? () =>
            findStoryYears(current, (year) =>
              qc.fetchQuery({ ...myStatsQuery(cid, api, `${year}`), staleTime: Infinity }),
            )
        : skipToken,
    staleTime: Infinity,
  });
  return years.data ?? [];
}
