import type { BridgeJob } from '@/api/types';

/** The Bridge job kind that generates a book's characters and recaps (and, from Bridge
 * Phase 1c, its description). */
export const SIDECARS_GENERATE = 'sidecars.generate';

/** The Bridge job kind that writes a book's description alone, from the notes a generate
 * run kept (Bridge Phase 1c). The console queues it, never the player. */
export const SIDECARS_DESCRIBE = 'sidecars.describe';

/** The Bridge job kind that finds a chapterless book's chapters in its narration and writes
 * them as the book's `.audiosilo/chapters.json` (Bridge Phase 1d). The console queues it,
 * never the player; while one is queued or working the server refuses a generate job for
 * the book (409 `detect_open`). */
export const CHAPTERS_DETECT = 'chapters.detect';

/** The Bridge job kind that shares a book's generated characters and recaps with the
 * community (Bridge Phase 2b). The console queues it, never the player; while one is queued
 * or working the server refuses a generate job for the book (409 `contribute_open`), except a
 * queued one held while the Contributions module is off, which a new generate cancels. */
export const SIDECARS_CONTRIBUTE = 'sidecars.contribute';

/** The Bridge job kind that aligns a book's ebook with its narration and writes the map as
 * the book's `.audiosilo/readalong.json` (Bridge Phase 3c; its feature, and its estimate's
 * kind, `readalong`). Params `{}`. While one is queued or working the server refuses a
 * generate or detect job for the book (409 `readalong_open`), and while either of those is
 * open, a read-along job (409 `generate_open` / `detect_open`); a book without an ebook is
 * refused 409 `no_ebook`. */
export const READALONG_ALIGN = 'readalong.align';

/** The Bridge feature (`ServerInfo.bridge.features`) that offers `readalong.align`. */
export const READALONG_FEATURE = 'readalong';

/** The kinds whose `done` job wrote the book's `.audiosilo/` files (see `latestDone`). */
const WRITES_BOOK: ReadonlySet<string> = new Set([
  SIDECARS_GENERATE,
  SIDECARS_DESCRIBE,
  CHAPTERS_DETECT,
  READALONG_ALIGN,
]);

/** The kinds a book's job list polls for while one of them is open: the player's generate
 * job, the console's chapter detection (Bridge Phase 1d), so a page open meanwhile sees it
 * end and reads the book's chapters again (`latestDone`), and a read-along job (Phase 3c),
 * so the book's `readalong` and its map are read again once it is made. */
const POLLED: ReadonlySet<string> = new Set([SIDECARS_GENERATE, CHAPTERS_DETECT, READALONG_ALIGN]);

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
 * `sidecars.generate`, `chapters.detect` or `readalong.align` job of it is claimed or running, every
 * `BRIDGE_IDLE_POLL_MS` while one only waits (queued or parked), else never. The last
 * answer, the one that saw the job end, stops it.
 */
export function bridgePollInterval(
  jobs: readonly BridgeJob[] | undefined,
  active: boolean,
): number | false {
  if (!active) return false;
  let interval: number | false = false;
  for (const j of jobs ?? []) {
    if (!POLLED.has(j.kind)) continue;
    if (j.state === 'claimed' || j.state === 'running') return BRIDGE_POLL_MS;
    if (isOpenJob(j)) interval = BRIDGE_IDLE_POLL_MS;
  }
  return interval;
}

/**
 * How often the confirmation's estimate is read again while it is open and `active` (the
 * app in the foreground): while its `open_job` is a share holding Generate back (an open
 * `sidecars.contribute`, Bridge Phase 2b: it files issues, no agent, so it ends in seconds),
 * every `BRIDGE_POLL_MS` once it is claimed or running and every `BRIDGE_IDLE_POLL_MS` while
 * it waits, so the hold lifts once it ends. A chapter detection (hours) is not waited for in
 * the dialog. Else never.
 */
export function estimatePollInterval(
  openJob: BridgeJob | undefined,
  active: boolean,
): number | false {
  if (!active || openJob?.kind !== SIDECARS_CONTRIBUTE || !isOpenJob(openJob)) return false;
  return openJob.state === 'claimed' || openJob.state === 'running'
    ? BRIDGE_POLL_MS
    : BRIDGE_IDLE_POLL_MS;
}

/** A book's newest `done` job that wrote its `.audiosilo/` files (`sidecars.generate`, the
 * console's `sidecars.describe`, its `chapters.detect` or a `readalong.align`): the book was
 * rescanned, so what
 * the book's answers say about it (its chapters included) may be stale. */
export function latestDone(jobs: readonly BridgeJob[] | undefined): BridgeJob | undefined {
  let latest: BridgeJob | undefined;
  for (const j of jobs ?? []) {
    if (j.state !== 'done' || !WRITES_BOOK.has(j.kind)) continue;
    if (!latest || j.id > latest.id) latest = j;
  }
  return latest;
}

/** The engine stages a generate run passes before it can have found a markerless book's
 * chapters in the narration (Bridge Phase 1d). */
const BEFORE_CHAPTERS: ReadonlySet<string> = new Set([
  'inspecting',
  'splitting',
  'asr',
  'chapter_detecting',
]);

/** A book's running generate job once it is past chapter detection, with a mark for what
 * it reports now (its step, else its stage), which changes as the run moves on. The run
 * saves the chapters it found long before its end (Bridge Phase 1d), between two such
 * reports: the book's chapters are read again once per mark (`refreshMidRun`), so a read
 * that came just before the save is followed by one after it. Undefined otherwise. */
export function midRunCheckpoint(
  jobs: readonly BridgeJob[] | undefined,
): { job: BridgeJob; mark: string } | undefined {
  const job = latestJob(jobs, SIDECARS_GENERATE);
  const stage = job?.progress?.stage;
  if (!job || job.state !== 'running' || !stage || BEFORE_CHAPTERS.has(stage)) return undefined;
  return { job, mark: `${job.id}:${job.progress?.step || stage}` };
}
