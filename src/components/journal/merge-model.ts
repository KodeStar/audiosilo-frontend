/**
 * Merging one paged, newest-first list per server into ONE newest-first list (the
 * Journal covers every signed-in server). Pure, so the paging rule is tested apart from
 * the queries.
 *
 * The rule that keeps the merge honest while pages are still arriving: a server that has
 * more pages has only told us about rows down to its oldest loaded one. Anything older
 * than that, from ANY server, could still have a newer neighbour on that server's next
 * page. So the merged list is cut at the newest such "frontier" (the boundary), and the
 * servers sitting on it are the ones to ask for their next page when the reader reaches
 * the end. A server still loading its first page, failed or unable to list is left out of
 * the boundary: one slow or broken server never holds the others back (it just pops its
 * rows in when they come).
 */

export type SourceStatus = 'loading' | 'ready' | 'error' | 'unsupported';

/** One server's list as its infinite query has it right now. */
export type SourceSnapshot<T> = {
  connectionId: string;
  connectionName: string;
  status: SourceStatus;
  /** Every loaded row, newest first (the server's order). */
  rows: readonly T[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
};

/** A row tagged with the server it came from. */
export type Sourced<T> = T & { connectionId: string; connectionName: string };

export type Merged<T> = {
  /** Every row safe to show, newest first. */
  rows: Sourced<T>[];
  /** Whether some server has older rows still to load. */
  hasMore: boolean;
  /** The servers to ask for their next page (those sitting on the boundary). */
  fetchFrom: string[];
  /** Whether any server is asking for its next page right now. */
  isFetchingMore: boolean;
};

const timeOfRow = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * The servers' rows merged newest first (by `timeOf`, ties in connection order, then
 * the server's own order), cut at the boundary described above.
 */
export function mergeNewestFirst<T>(
  sources: readonly SourceSnapshot<T>[],
  timeOf: (row: T) => string,
): Merged<T> {
  const tagged: { row: Sourced<T>; time: number; source: number; index: number }[] = [];
  // The frontier of each server that has more: the time of its oldest loaded row.
  const frontiers: { cid: string; time: number }[] = [];
  sources.forEach((s, source) => {
    if (s.status !== 'ready') return;
    s.rows.forEach((row, index) =>
      tagged.push({
        row: { ...row, connectionId: s.connectionId, connectionName: s.connectionName },
        time: timeOfRow(timeOf(row)),
        source,
        index,
      }),
    );
    if (s.hasNextPage) {
      const last = s.rows[s.rows.length - 1];
      frontiers.push({ cid: s.connectionId, time: last ? timeOfRow(timeOf(last)) : Infinity });
    }
  });
  const boundary = frontiers.length > 0 ? Math.max(...frontiers.map((f) => f.time)) : -Infinity;
  tagged.sort((a, b) => b.time - a.time || a.source - b.source || a.index - b.index);
  return {
    rows: tagged.filter((r) => r.time >= boundary).map((r) => r.row),
    hasMore: frontiers.length > 0,
    fetchFrom: frontiers.filter((f) => f.time >= boundary).map((f) => f.cid),
    isFetchingMore: sources.some((s) => s.isFetchingNextPage),
  };
}

/** The overall state of the servers' lists, for the page's loading / error / empty
 * states: `loading` while no server has answered and one still might, `error` when every
 * server that can list failed, else `ready` (possibly with an empty merge). */
export function overallStatus(
  sources: readonly Pick<SourceSnapshot<unknown>, 'status'>[],
): 'loading' | 'error' | 'unsupported' | 'ready' {
  const able = sources.filter((s) => s.status !== 'unsupported');
  if (able.length === 0) return sources.length === 0 ? 'ready' : 'unsupported';
  if (able.some((s) => s.status === 'ready')) return 'ready';
  if (able.some((s) => s.status === 'loading')) return 'loading';
  return 'error';
}
