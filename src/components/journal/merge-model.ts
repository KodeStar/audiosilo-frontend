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

/** A row's ISO time as epoch ms (0 when it can't be read). */
export const timeOfRow = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** Each row's tagged copy (by the server's row object, which React Query keeps while the
 * row is unchanged), so a row keeps its identity from one merge to the next. */
const tags = new WeakMap<object, Sourced<object>>();

function tagged<T extends object>(row: T, s: SourceSnapshot<T>): Sourced<T> {
  const hit = tags.get(row) as Sourced<T> | undefined;
  if (hit?.connectionId === s.connectionId && hit.connectionName === s.connectionName) return hit;
  const out = { ...row, connectionId: s.connectionId, connectionName: s.connectionName };
  tags.set(row, out);
  return out;
}

/**
 * The servers' rows merged newest first (by `timeOf`, ties in connection order, then
 * the server's own order), cut at the boundary described above. Each server's list is
 * already newest first, so this is a k-way merge of their heads (no sort), stopping at the
 * boundary.
 */
export function mergeNewestFirst<T extends object>(
  sources: readonly SourceSnapshot<T>[],
  timeOf: (row: T) => string,
): Merged<T> {
  const ready = sources.filter((s) => s.status === 'ready');
  const time = (s: SourceSnapshot<T>, i: number) =>
    i < s.rows.length ? timeOfRow(timeOf(s.rows[i])) : -Infinity;
  // The frontier of each server that has more: the time of its oldest loaded row.
  const frontiers = ready
    .filter((s) => s.hasNextPage)
    .map((s) => ({
      cid: s.connectionId,
      time: s.rows.length > 0 ? time(s, s.rows.length - 1) : Infinity,
    }));
  const boundary = frontiers.length > 0 ? Math.max(...frontiers.map((f) => f.time)) : -Infinity;

  const rows: Sourced<T>[] = [];
  const next = ready.map(() => 0);
  const heads = ready.map((s) => time(s, 0));
  for (;;) {
    let pick = -1;
    for (let i = 0; i < ready.length; i++) {
      if (next[i] < ready[i].rows.length && (pick < 0 || heads[i] > heads[pick])) pick = i;
    }
    if (pick < 0 || heads[pick] < boundary) break;
    const s = ready[pick];
    rows.push(tagged(s.rows[next[pick]], s));
    heads[pick] = time(s, ++next[pick]);
  }
  return {
    rows,
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
