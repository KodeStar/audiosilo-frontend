import type { Capabilities, UpcomingItem, UpcomingStatus } from '@/api/types';
import { isKidAccount } from '@/lib/account';
import { parseReleaseDate } from '@/lib/release-date';
import { seriesPositionValue } from '@/lib/series-position';

/**
 * Upcoming releases (Track U2): the pure rules behind `useUpcomingAll`, the Home rail and
 * the Upcoming screen (a release date's own rules are `src/lib/release-date.ts`).
 * Framework-free and tested apart.
 */

/** An upcoming item with the connection it came from. */
export type SourcedUpcomingItem = UpcomingItem & { connectionId: string; connectionName: string };

/** One connection's answer: its job's status (`ok`, `pending`, `stale`). */
export type UpcomingServerStatus = {
  connectionId: string;
  connectionName: string;
  status: UpcomingStatus | (string & {});
};

/** How long an item wears its "New" badge after the server first listed it. */
const UPCOMING_NEW_MS = 7 * 86_400_000;

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
  return parseReleaseDate(value)?.start ?? '';
}

const SECTION_ORDER = ['preorder', 'released', 'missing'] as const;

/** The section an item belongs to: preorders, releases, then missing volumes (a kind this
 * player doesn't know is shown with them). */
export function upcomingSectionOf(
  item: Pick<UpcomingItem, 'kind'>,
): (typeof SECTION_ORDER)[number] {
  return item.kind === 'preorder' ? 'preorder' : item.kind === 'released' ? 'released' : 'missing';
}

const kindRank = (item: UpcomingItem) => SECTION_ORDER.indexOf(upcomingSectionOf(item));

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** The wire's order across servers: preorders soonest first, releases newest first, then
 * missing volumes by series name and position (numeric: "2.5" before "10"); the work id
 * breaks ties (the server's `compareItems`). */
export function compareUpcoming(a: UpcomingItem, b: UpcomingItem): number {
  const rank = cmp(kindRank(a), kindRank(b));
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
 * a server's flags are still loading). A non-kid connection whose flags could not be read
 * (`failed`, from `useCapabilitiesAllRead`) is `unreadable`: settled, not loading, so a
 * page never waits on it forever.
 */
export function upcomingEligibility(
  connections: readonly { id: string; user?: Parameters<typeof isKidAccount>[0] }[],
  caps: Record<string, Capabilities | undefined>,
  failed: readonly string[] = [],
): { eligible: ReadonlySet<string>; available: boolean | undefined; unreadable: string[] } {
  const eligible = new Set<string>();
  const unreadable: string[] = [];
  let unknown = false;
  for (const c of connections) {
    if (isKidAccount(c.user)) continue;
    const flags = caps[c.id];
    if (flags) {
      if (flags.upcoming) eligible.add(c.id);
    } else if (failed.includes(c.id)) unreadable.push(c.id);
    else unknown = true;
  }
  return {
    eligible,
    available: eligible.size > 0 ? true : unknown ? undefined : false,
    unreadable,
  };
}
