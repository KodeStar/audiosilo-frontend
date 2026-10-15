import type { BridgeJob } from '@/api/types';

/** The Bridge job kind that generates a book's characters and recaps. */
export const SIDECARS_GENERATE = 'sidecars.generate';

/** How often a book's jobs are asked again while one of them is open and its surface is
 * on screen: the jobs take minutes to hours, and the server has no realtime channel. */
export const BRIDGE_POLL_MS = 10_000;

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
 * How often a book's job list polls (React Query's `refetchInterval`): every
 * `BRIDGE_POLL_MS` while a `sidecars.generate` job of it is open and the surface is
 * `active` (on screen, the app in the foreground), else never. The last answer, the one
 * that saw the job end, stops it.
 */
export function bridgePollInterval(
  jobs: readonly BridgeJob[] | undefined,
  active: boolean,
): number | false {
  if (!active) return false;
  return (jobs ?? []).some((j) => j.kind === SIDECARS_GENERATE && isOpenJob(j))
    ? BRIDGE_POLL_MS
    : false;
}

/**
 * Whether a `sidecars.generate` job finished (`done`) after `sinceMs`: the moment the
 * book's `/meta` answer in hand was fetched (0 for none). Its files were written and the
 * book rescanned after that answer, so the answer is stale and is read again: that is
 * how the tabs appear when a job ends, whether it ended while the page watched it or
 * while it was closed (the metadata is otherwise trusted for an hour).
 */
export function finishedSince(jobs: readonly BridgeJob[] | undefined, sinceMs: number): boolean {
  return (jobs ?? []).some((j) => {
    if (j.kind !== SIDECARS_GENERATE || j.state !== 'done') return false;
    const at = Date.parse(j.finished_at ?? j.updated_at);
    return Number.isFinite(at) && at > sinceMs;
  });
}

/** Whether a `sidecars.generate` job open in `before` is `done` in `after` (two answers
 * of the same list): the transition seen as it happens, which needs no clock (a device
 * clock ahead of the server's could hide it from `finishedSince`). */
export function turnedDone(
  before: readonly BridgeJob[] | undefined,
  after: readonly BridgeJob[],
): boolean {
  const open = new Set(
    (before ?? []).filter((j) => j.kind === SIDECARS_GENERATE && isOpenJob(j)).map((j) => j.id),
  );
  return after.some((j) => j.state === 'done' && open.has(j.id));
}
