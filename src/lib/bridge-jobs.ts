import type { BridgeJob } from '@/api/types';

/** The Bridge job kind that generates a book's characters and recaps. */
export const SIDECARS_GENERATE = 'sidecars.generate';

/** How often a book's jobs are asked again while one of them is being worked on
 * (claimed or running) and its surface is on screen: the jobs take minutes to hours, and
 * the server has no realtime channel. */
export const BRIDGE_POLL_MS = 10_000;

/** How often while its job only waits (queued, or parked until someone looks or its
 * retry time comes): nothing moves quickly then. */
export const BRIDGE_IDLE_POLL_MS = 60_000;

/** The states a job is still the Bridge's business in (the server's `OpenStatesSQL`). */
const OPEN_STATES: ReadonlySet<string> = new Set([
  'queued',
  'claimed',
  'running',
  'needs_attention',
]);

/** Whether `job` has not ended yet (queued, claimed, running or parked). */
export function isOpenJob(job: Pick<BridgeJob, 'state'>): boolean {
  return OPEN_STATES.has(job.state);
}

/** The newest job of `kind` (the highest id: ids ascend as jobs are queued), whatever
 * order the list came in. */
export function latestJob(jobs: readonly BridgeJob[] | undefined, kind: string) {
  let latest: BridgeJob | undefined;
  for (const j of jobs ?? []) if (j.kind === kind && (!latest || j.id > latest.id)) latest = j;
  return latest;
}

/**
 * How often a book's job list polls (React Query's `refetchInterval`) while the surface is
 * `active` (on screen, the app in the foreground): every `BRIDGE_POLL_MS` while a
 * `sidecars.generate` job of it is claimed or running, every `BRIDGE_IDLE_POLL_MS` while
 * one only waits (queued or parked), else never. The last answer, the one that saw the
 * job end, stops it.
 */
export function bridgePollInterval(
  jobs: readonly BridgeJob[] | undefined,
  active: boolean,
): number | false {
  if (!active) return false;
  let interval: number | false = false;
  for (const j of jobs ?? []) {
    if (j.kind !== SIDECARS_GENERATE) continue;
    if (j.state === 'claimed' || j.state === 'running') return BRIDGE_POLL_MS;
    if (isOpenJob(j)) interval = BRIDGE_IDLE_POLL_MS;
  }
  return interval;
}

/** A book's newest `sidecars.generate` job that is `done`: its files were written and
 * the book rescanned, so what the book's answers say about it may be stale. */
export function latestDone(jobs: readonly BridgeJob[] | undefined): BridgeJob | undefined {
  return latestJob(
    jobs?.filter((j) => j.state === 'done'),
    SIDECARS_GENERATE,
  );
}

/** When a job finished, as the server says (`finished_at`, else its last update). */
export function finishedAt(job: Pick<BridgeJob, 'finished_at' | 'updated_at'>): string {
  return job.finished_at ?? job.updated_at;
}

/**
 * Whether a book's cached answers (its `/meta` and its item) are read again for the
 * finish of `job` (done): when this answer saw it turn done (`turned`, which needs no
 * clock), or when one of them was fetched before it finished (`fetchedAt`, each answer's
 * fetch time on the device clock, 0 for none yet). That is how the tabs appear when a job
 * ends, whether it ended while the page watched it or while it was closed (the metadata
 * is otherwise trusted for an hour). A device clock behind the server's makes every
 * answer look older than the finish, so the caller acts on each finish once.
 */
export function staleAfterFinish(
  job: Pick<BridgeJob, 'finished_at' | 'updated_at'>,
  fetchedAt: readonly number[],
  turned: boolean,
): boolean {
  if (turned) return true;
  const at = Date.parse(finishedAt(job));
  return Number.isFinite(at) && fetchedAt.some((t) => t > 0 && t < at);
}

/** Whether a `sidecars.generate` job open in `before` is `done` in `after` (two answers
 * of the same list): the transition seen as it happens. */
export function turnedDone(
  before: readonly BridgeJob[] | undefined,
  after: readonly BridgeJob[],
): boolean {
  const open = new Set(
    (before ?? []).filter((j) => j.kind === SIDECARS_GENERATE && isOpenJob(j)).map((j) => j.id),
  );
  return after.some((j) => j.state === 'done' && open.has(j.id));
}
