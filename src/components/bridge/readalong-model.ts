import { type ApiErrorKind, apiErrorKind } from '@/api/client';
import type { BridgeJob, ReadalongEstimate } from '@/api/types';
import {
  CHAPTERS_DETECT,
  isOpenJob,
  READALONG_ALIGN,
  SIDECARS_GENERATE,
  statusJobOf,
} from '@/lib/bridge-jobs';

// The rules behind the player's "Make read-along" (Bridge Phase 3c, admin only, in the
// companion's Text tab): when it is offered, why it is held back, how a refusal reads.
// Pure, so each is tested on its own; who may is `mayMakeReadalong`
// (`src/reader/readalong-gating.ts`).

/** The `readalong.align` job a book's status shows: its newest one while it is open
 * (queued, running or parked) or once it failed. A cancelled or finished one shows nothing
 * (the offer is back, or the text is there). */
export function readalongStatusJob(jobs: readonly BridgeJob[] | undefined): BridgeJob | undefined {
  return statusJobOf(jobs, READALONG_ALIGN);
}

/**
 * Whether an admin who may (`allowed`) is offered "Make read-along" for a book: it has an
 * ebook, its jobs are known (no button that vanishes a moment later) and none shows its
 * status. The surface offers it only where no map can be followed (none, or a stale one).
 */
export function readalongOffer(opts: {
  allowed: boolean;
  hasEbook: boolean;
  jobsKnown: boolean;
  showsJob: boolean;
}): boolean {
  return opts.allowed && opts.hasEbook && opts.jobsKnown && !opts.showsJob;
}

/** Why making is held back, in the app's words (`readalongBlockKey`): the server's refusal
 * codes, and the book's own read-along job already open (`readalong_open`). */
const BLOCK_KEY = {
  no_ebook: 'bridge.readalong.noEbook',
  library_not_writable: 'bridge.generate.notWritable',
  generate_open: 'bridge.readalong.generateOpen',
  detect_open: 'bridge.readalong.detectOpen',
  readalong_open: 'bridge.readalong.readalongOpen',
} as const satisfies Partial<Record<ApiErrorKind, string>>;

export type ReadalongBlockKey = (typeof BLOCK_KEY)[keyof typeof BLOCK_KEY];

/** The open job kinds that hold Make back: those the server refuses a read-along job for
 * (its `refusedWhileOpen` for `readalong.align`: 409 `generate_open` / `detect_open`, one
 * engine book per audio on the Bridge), and the book's own read-along job (queued from the
 * console while the job list here had not seen it: queuing again would only answer that
 * job). */
const OPEN_JOB_KEY: Readonly<Record<string, ReadalongBlockKey>> = {
  [SIDECARS_GENERATE]: BLOCK_KEY.generate_open,
  [CHAPTERS_DETECT]: BLOCK_KEY.detect_open,
  [READALONG_ALIGN]: BLOCK_KEY.readalong_open,
};

/**
 * Why Make is held back in the confirmation, as words, else null: the book has no ebook
 * (409 `no_ebook`), the Bridge can't write the library (the map would have nowhere to go),
 * or an open job of a kind in `OPEN_JOB_KEY`.
 */
export function readalongBlockKey(
  e: Pick<ReadalongEstimate, 'ebook' | 'writable' | 'open_job'>,
): ReadalongBlockKey | null {
  if (!e.ebook) return BLOCK_KEY.no_ebook;
  if (!e.writable) return BLOCK_KEY.library_not_writable;
  const job = e.open_job;
  return job && isOpenJob(job) && Object.hasOwn(OPEN_JOB_KEY, job.kind)
    ? OPEN_JOB_KEY[job.kind]
    : null;
}

/** The refusals a queue of `readalong.align` can meet, by `apiErrorKind`. */
const REFUSAL_KEY: Readonly<
  Partial<Record<ApiErrorKind, ReadalongBlockKey | 'bridge.generate.unavailable'>>
> = {
  ...BLOCK_KEY,
  kind_unavailable: 'bridge.generate.unavailable',
};

/** A refusal of making a book's read-along in the app's words (never the server's), else
 * `fallback`. */
export function readalongRefusalKey<F extends string>(error: unknown, fallback: F) {
  return REFUSAL_KEY[apiErrorKind(error)] ?? fallback;
}
