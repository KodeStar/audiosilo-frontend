/**
 * A work's release date as the community metadata states it (Track U2): pure, so
 * `formatReleaseDate`, the series page's dated ghosts and the Upcoming rules read it one
 * way without pulling in each other.
 */

const RELEASE_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/** A release date the metadata states (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, a real month and
 * day), split into its parts with its first day (`start`: "2027" -> "2027-01-01"); null for
 * anything else ("2026-13", "Nov 2026"). */
export function parseReleaseDate(
  value: string | undefined,
): { year: string; month?: string; day?: string; start: string } | null {
  const m = value ? RELEASE_DATE.exec(value) : null;
  if (!value || !m) return null;
  const [, year, month, day] = m;
  const start = `${year}-${month ?? '01'}-${day ?? '01'}`;
  const date = new Date(`${start}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, value.length) !== value) {
    return null;
  }
  return { year, month, day, start };
}

/**
 * Whether a release date is still ahead of `now`, compared at its own precision against
 * the UTC day (the server's rule, `upcoming.releaseIsFuture`): "2027" is ahead in 2026 but
 * "2026" is not, "2026-11" is ahead in October 2026 but not in November, and a book out
 * today is out. An unreadable or absent date is never ahead.
 */
export function releaseIsFuture(value: string | undefined, now: Date): boolean {
  if (!value || !parseReleaseDate(value)) return false;
  return value > now.toISOString().slice(0, value.length);
}
