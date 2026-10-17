import type { BridgeJob } from '@/api/types';

/** The Bridge job kind that generates a book's characters and recaps (and, from Bridge
 * Phase 1c, its description). */
export const SIDECARS_GENERATE = 'sidecars.generate';

/** The Bridge job kind that writes a book's description alone, from the notes a generate
 * run kept (Bridge Phase 1c). The console queues it, never the player. */
export const SIDECARS_DESCRIBE = 'sidecars.describe';

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

/** A book's newest `done` job that wrote its `.audiosilo/` files (`sidecars.generate`, or
 * the console's `sidecars.describe`): the book was rescanned, so what the book's answers
 * say about it may be stale. */
export function latestDone(jobs: readonly BridgeJob[] | undefined): BridgeJob | undefined {
  let latest: BridgeJob | undefined;
  for (const j of jobs ?? []) {
    if (j.state !== 'done' || (j.kind !== SIDECARS_GENERATE && j.kind !== SIDECARS_DESCRIBE))
      continue;
    if (!latest || j.id > latest.id) latest = j;
  }
  return latest;
}
