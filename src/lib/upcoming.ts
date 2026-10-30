import type { Capabilities, UpcomingItem, UpcomingStatus } from '@/api/types';
import { isKidAccount } from '@/lib/account';
import { seriesPositionValue } from '@/lib/series-position';

/**
 * Upcoming releases (Track U2): the pure rules behind `useUpcomingAll`, the Home rail, the
 * Upcoming screen and the series page's dated ghosts. Framework-free and tested apart.
 */

/** An upcoming item with the connection it came from. */
export type SourcedUpcomingItem = UpcomingItem & { connectionId: string; connectionName: string };

/** One connection's answer: its job's status (`ok`, `pending`, `stale`). */
export type UpcomingServerStatus = {
  connectionId: string;
  connectionName: string;
  status: UpcomingStatus | (string & {});
};

const RELEASE_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

/** Whether `value` is a release date the metadata states (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`,
 * a real month and day). */
function isReleaseDate(value: string | undefined): value is string {
  if (!value || !RELEASE_DATE.test(value)) return false;
  const [y, m = '01', d = '01'] = value.split('-');
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, value.length) === value;
}

/**
 * Whether a release date is still ahead of `now`, compared at its own precision against
 * the UTC day (the server's rule, `upcoming.releaseIsFuture`): "2027" is ahead in 2026 but
 * "2026" is not, "2026-11" is ahead in October 2026 but not in November, and a book out
 * today is out. An unreadable or absent date is never ahead.
 */
export function releaseIsFuture(value: string | undefined, now: Date): boolean {
  if (!isReleaseDate(value)) return false;
  return value > now.toISOString().slice(0, value.length);
}

/** How long an item wears its "New" badge after the server first listed it. */
export const UPCOMING_NEW_MS = 7 * 86_400_000;

/** Whether an item is new: its server first listed it (`first_seen_at`) within the last
 * seven days of `now`. */
export function isNewUpcoming(item: Pick<UpcomingItem, 'first_seen_at'>, now: Date): boolean {
  const seen = Date.parse(item.first_seen_at);
  if (Number.isNaN(seen)) return false;
  const age = now.getTime() - seen;
  return age < UPCOMING_NEW_MS && age > -UPCOMING_NEW_MS;
}

/** A release date as the feed sorts it: its first day ("2027" -> "2027-01-01"), '' when
 * unreadable (the server's `datePrefix`). */
function datePrefix(value: string | undefined): string {
  if (!isReleaseDate(value)) return '';
  const [y, m = '01', d = '01'] = value.split('-');
  return `${y}-${m}-${d}`;
}

/** The kinds in their order: preorders, releases, then missing volumes (and a kind this
 * player doesn't know, shown with them). */
function kindRank(kind: string): number {
  return kind === 'preorder' ? 0 : kind === 'released' ? 1 : 2;
}

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** The wire's order across servers: preorders soonest first, releases newest first, then
 * missing volumes by series name and position (numeric: "2.5" before "10"); the work id
 * breaks ties (the server's `compareItems`). */
export function compareUpcoming(a: UpcomingItem, b: UpcomingItem): number {
  const rank = cmp(kindRank(a.kind), kindRank(b.kind));
  if (rank !== 0) return rank;
  if (a.kind === 'preorder') {
    return cmp(datePrefix(a.release_date), datePrefix(b.release_date)) || cmp(a.work.id, b.work.id);
  }
  if (a.kind === 'released') {
    return cmp(datePrefix(b.release_date), datePrefix(a.release_date)) || cmp(a.work.id, b.work.id);
  }
  return (
    cmp(a.series.name.toLowerCase(), b.series.name.toLowerCase()) ||
    cmp(a.series.id, b.series.id) ||
    cmp(seriesPositionValue(a.series.position) ?? 0, seriesPositionValue(b.series.position) ?? 0) ||
    cmp(a.work.id, b.work.id)
  );
}

/** Every connection's items (in connection order) as one list: tagged with their source,
 * each work once (the first connection's row wins: each server already drops a work the
 * caller holds there), in the wire's order across servers. */
export function mergeUpcoming(
  perConnection: readonly {
    connectionId: string;
    connectionName: string;
    items: readonly UpcomingItem[];
  }[],
): SourcedUpcomingItem[] {
  const seen = new Set<string>();
  const out: SourcedUpcomingItem[] = [];
  for (const { connectionId, connectionName, items } of perConnection) {
    for (const item of items) {
      if (seen.has(item.work.id)) continue;
      seen.add(item.work.id);
      out.push({ ...item, connectionId, connectionName });
    }
  }
  return out.sort(compareUpcoming);
}

/**
 * Which connections Upcoming may ask (`eligible`: the server advertises `upcoming` and the
 * user there is not a kid, whom the route refuses) and whether there is any (`available`:
 * true as soon as one is, false once every connection is known not to be, undefined while
 * a server's flags are still loading).
 */
export function upcomingEligibility(
  connections: readonly { id: string; user?: Parameters<typeof isKidAccount>[0] }[],
  caps: Record<string, Capabilities | undefined>,
): { eligible: ReadonlySet<string>; available: boolean | undefined } {
  const eligible = new Set<string>();
  let unknown = false;
  for (const c of connections) {
    if (isKidAccount(c.user)) continue;
    const flags = caps[c.id];
    if (!flags) unknown = true;
    else if (flags.upcoming) eligible.add(c.id);
  }
  return { eligible, available: eligible.size > 0 ? true : unknown ? undefined : false };
}
