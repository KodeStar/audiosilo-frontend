import { useCallback, useEffect, useMemo, useState } from 'react';

import { useMyStats } from '@/api/hooks';

import { hasData, OLDEST_YEAR } from './year-model';

/** How many years back the picker looks at most. */
const MAX_YEARS_BACK = 25;

/**
 * The past years with a story on a server, newest first, for the year picker. The wire
 * has no "which years have data", so it asks each year in turn with the stats route the
 * story itself reads (`/me/stats?range=YYYY`, the same cache entry, so picking a year
 * shows at once): last year always, then on back while a year has data or the year
 * before it does (its `previous` totals), so a single quiet year doesn't hide the ones
 * before it. Two quiet years in a row end the search. `current` is this year (`YYYY`,
 * server time), unknown until the story's own stats arrive.
 */
export function useStoryYears(cid: string, current: number | null) {
  const [found, setFound] = useState<{ cid: string; years: Record<number, boolean> }>({
    cid,
    years: {},
  });
  const onResult = useCallback(
    (year: number, has: boolean) =>
      setFound((f) => {
        const base = f.cid === cid ? f.years : {};
        return base[year] === has ? f : { cid, years: { ...base, [year]: has } };
      }),
    [cid],
  );
  const past = useMemo(
    () =>
      // A server switch starts over.
      found.cid !== cid
        ? []
        : Object.entries(found.years)
            .filter(([, has]) => has)
            .map(([y]) => Number(y))
            .sort((a, b) => b - a),
    [found, cid],
  );
  const probe =
    current !== null && current - 1 >= OLDEST_YEAR ? (
      <YearProbe key={cid} cid={cid} year={current - 1} depth={1} onResult={onResult} />
    ) : null;
  return { past, probe };
}

/** Asks one year's stats, reports whether it has a story, and asks the year before it
 * while there may be more. Renders nothing visible. */
function YearProbe({
  cid,
  year,
  depth,
  onResult,
}: {
  cid: string;
  year: number;
  depth: number;
  onResult: (year: number, has: boolean) => void;
}) {
  const stats = useMyStats(`${year}`, cid).data;
  const has = stats ? hasData(stats.totals) : null;
  const older = stats ? hasData(stats.previous) : false;
  useEffect(() => {
    if (has !== null) onResult(year, has);
  }, [year, has, onResult]);
  if (has === null || !(has || older)) return null;
  if (depth >= MAX_YEARS_BACK || year - 1 < OLDEST_YEAR) return null;
  return <YearProbe cid={cid} year={year - 1} depth={depth + 1} onResult={onResult} />;
}
