import { type ApiErrorCode, type ApiErrorKind, apiErrorKind } from '@/api/client';
import type {
  BookMetaGenerated,
  BookRef,
  BridgeEstimate,
  BridgeEstimateBook,
  BridgeJob,
  ServerInfo,
  SidecarsGenerateParams,
  User,
} from '@/api/types';
import {
  CHAPTERS_DETECT,
  isBridgeAdmin,
  READALONG_ALIGN,
  SIDECARS_CONTRIBUTE,
  SIDECARS_GENERATE,
  statusJobOf,
} from '@/lib/bridge-jobs';

// The rules behind the player's one Bridge action, "Generate characters and recaps"
// (Bridge Phase 1a): who may see it, when it is offered, how a job's state reads and the
// order books are queued in. Pure, so each is tested on its own.

/** The Bridge feature (`ServerInfo.bridge.features`) that offers `sidecars.generate`. */
const SIDECARS_FEATURE = 'sidecars';

/** What the player always asks for: the source the Bridge picks (the ebook beside the
 * audio when there is one) and results kept on this server. The player never offers to
 * contribute them to the community (the console does). */
export const GENERATE_PARAMS: SidecarsGenerateParams = { source: 'auto', contribute: 'local' };

/**
 * Whether this person may generate characters and recaps on this server: the player's
 * first admin-only UI (Bridge decision 9). An admin (never a household member, a kid's
 * account or a demo account, whatever their role says), on a server whose Bridge is online
 * and offers `sidecars`, with community metadata on (generated content is served through
 * `/meta`, so it needs it too). An older server has no `bridge` flag: never.
 */
export function mayGenerate(
  user: Pick<User, 'role' | 'is_demo' | 'managed_by' | 'member_kind'> | null | undefined,
  server: Pick<ServerInfo, 'capabilities' | 'bridge'> | null | undefined,
): boolean {
  if (!server || !isBridgeAdmin(user)) return false;
  const caps = server.capabilities;
  return (
    caps?.bridge === true &&
    caps.metadata === true &&
    (server.bridge?.features ?? []).includes(SIDECARS_FEATURE)
  );
}

/** What of a book's characters and recaps is in hand: the lists the page renders (the
 * community's, else the generated ones) and which of them were generated here. */
export type GenerateContent = {
  characters?: readonly unknown[];
  recaps?: readonly unknown[];
  generated?: BookMetaGenerated;
};

/** Whether the community (not this server's own files) has the book's characters and
 * recaps, per dimension: a list is the community's when it is there and was not generated
 * here. The server layers generated content only into a dimension the community lacks
 * (fill-only), so a generated list never stands for the community's. */
export function communityCoverage(content: GenerateContent | undefined): {
  characters: boolean;
  recaps: boolean;
} {
  return {
    characters: (content?.characters?.length ?? 0) > 0 && !content?.generated?.characters,
    recaps: (content?.recaps?.length ?? 0) > 0 && !content?.generated?.recaps,
  };
}

/** Whether any of the book's characters or recaps came from this server's own files. */
function hasGenerated(content: GenerateContent | undefined): boolean {
  return !!(content?.generated?.characters || content?.generated?.recaps);
}

/** The `sidecars.generate` job a book's status shows: its newest one while it is open
 * (queued, running or parked) or once it failed. A cancelled or finished one shows
 * nothing (the button is back, or the tabs are there). */
export function statusJob(jobs: readonly BridgeJob[] | undefined): BridgeJob | undefined {
  return statusJobOf(jobs, SIDECARS_GENERATE);
}

/**
 * What a book offers an admin (Bridge Phase 1e, the one rule the console shares): while
 * the community lacks either characters or recaps, `regenerate` (quieter, the overflow
 * menu) when some were generated here, else `generate`. When the community has both,
 * `covered`: no Generate, a line that says so instead (old generated files are masked by
 * the community's anyway). Nothing until the book's metadata and its jobs are known (no
 * button that vanishes a moment later), or while a job shows its status.
 */
export function generateOffer(opts: {
  allowed: boolean;
  metaKnown: boolean;
  jobsKnown: boolean;
  /** A job's status shows (`statusJob` has one). */
  showsJob: boolean;
  content: GenerateContent | undefined;
}): 'generate' | 'regenerate' | 'covered' | null {
  const { allowed, metaKnown, jobsKnown, showsJob, content } = opts;
  if (!allowed || !metaKnown || !jobsKnown || showsJob) return null;
  const community = communityCoverage(content);
  if (community.characters && community.recaps) return 'covered';
  return hasGenerated(content) ? 'regenerate' : 'generate';
}

/** The order books are queued in: the earlier books of the series first, in reading
 * order (the estimate's `earlier`), when the admin kept that switch on, then this one.
 * Ids ascend in that order, so the Bridge takes them in it. */
export function queueOrder(
  current: BookRef,
  earlier: readonly BridgeEstimateBook[],
  includeEarlier: boolean,
): BookRef[] {
  const before = includeEarlier
    ? earlier.map((b) => ({ library_id: b.library_id, path: b.path }))
    : [];
  return [
    ...before.filter((b) => !(b.library_id === current.library_id && b.path === current.path)),
    current,
  ];
}

/** Queue `books` one after another (each waits for the one before, so their ids keep
 * the order), stopping at the first refusal: the books queued before it stay queued. */
export async function queueInOrder(
  books: readonly BookRef[],
  queue: (book: BookRef) => Promise<BridgeJob>,
): Promise<{ queued: BridgeJob[]; error?: unknown }> {
  const queued: BridgeJob[] = [];
  for (const book of books) {
    try {
      queued.push(await queue(book));
    } catch (error) {
      return { queued, error };
    }
  }
  return { queued };
}

// --- How a job reads ---------------------------------------------------------------

/** The engine's stage names (and the Bridge's own steps) the player has words for. */
const STAGES = [
  'inspecting',
  'splitting',
  'asr',
  // Bridge Phase 1d: a book with no chapter markers, transcribed in windows, gets its
  // chapters from the narration before the transcript is cleaned up.
  'chapter_detecting',
  'sanitizing',
  'qa_sweep',
  'qa_adjudicating',
  'retranscribing',
  // Bridge Phase 3c: a read-along job lines the ebook's sentences up with the transcript.
  'readalong_aligning',
  'markers_normalizing',
  'spelling_research',
  'correcting',
  'fact_pass',
  'synthesizing',
  'auditing',
  'fixing',
  'validating',
  'ready',
  // Every run passes it (a local one only saves its results): worded as saving.
  'contributing',
  'extracting',
  'chapter_mapping',
  'waiting',
  // Bridge Phase 1c: every run writes the book's description as it saves its results.
  'describing',
  'writing',
  'rescanning',
] as const;

export type GenerateStage = (typeof STAGES)[number] | 'working';

const KNOWN_STAGES: ReadonlySet<string> = new Set(STAGES);

/** The Bridge's own saving steps, and the engine stages before `ready`. A generate run
 * saves the chapters it found in the narration long before its end (Bridge Phase 1d),
 * sending these steps with the engine's stage at the time; the save at the end sends
 * them with the stage `done`. */
const SAVE_STEPS: ReadonlySet<string> = new Set(['writing', 'rescanning']);
const BEFORE_READY: ReadonlySet<string> = new Set(STAGES.slice(0, STAGES.indexOf('ready')));

/** The stage a job's progress names (its `step`, always set by the Bridge, else the
 * engine's `stage`), as one the player has words for: an unknown one (a newer Bridge)
 * reads as a generic "Working". A save step sent mid-run (the early chapters save) reads
 * as the engine's stage, never as "Saving the results" hours before the end. */
export function stageOf(progress: { step?: string; stage?: string } | null | undefined) {
  const step = progress?.step;
  const stage = progress?.stage;
  const name =
    step && SAVE_STEPS.has(step) && stage && BEFORE_READY.has(stage) ? stage : step || stage || '';
  return (KNOWN_STAGES.has(name) ? name : 'working') as GenerateStage;
}

/** The park codes the player names, grouped by what the admin would do about them. */
const PARK_REASON: Readonly<Record<string, ParkReason>> = {
  agent_unavailable: 'agent',
  agent_credential_refused: 'agent',
  agent_rate_limited: 'rateLimited',
  budget_exceeded: 'budget',
  book_not_writable: 'notWritable',
  // The Bridge's own park when the library's mapping stops being writable mid-job.
  library_not_writable: 'notWritable',
  asr_unavailable: 'asr',
  asr_decode_timeout: 'asr',
  // No ASR worker is connected, and the Bridge waits for one.
  asr_worker_waiting: 'worker',
  media_tools_unavailable: 'mediaTools',
  markers_not_confident: 'chapters',
  ebook_chapters_not_confident: 'chapters',
  ebook_no_chapters: 'chapters',
  // Bridge Phase 1d: no chapter headings were heard with confidence in the narration.
  chapters_not_detected: 'chaptersNotDetected',
  ebook_unreadable: 'ebook',
  core_needed: 'core',
  core_pending: 'core',
  contrib_unavailable: 'contrib',
  manifest_changed: 'changed',
  qa_no_converge: 'review',
  fix_loop_exhausted: 'review',
  spelling_gate_failure: 'review',
  agent_validation_exhausted: 'review',
  supervisor_escalated: 'review',
  supervisor_budget: 'review',
};

export type ParkReason =
  | 'agent'
  | 'rateLimited'
  | 'budget'
  | 'notWritable'
  | 'asr'
  | 'worker'
  | 'mediaTools'
  | 'chapters'
  | 'chaptersNotDetected'
  | 'ebook'
  | 'core'
  | 'contrib'
  | 'changed'
  | 'review'
  | 'other';

/** A park code as a short reason the player can say; an unknown code is `other`. */
export function parkReason(code: string | undefined): ParkReason {
  return code && Object.hasOwn(PARK_REASON, code) ? PARK_REASON[code] : 'other';
}

/** Whether a park ends by itself with no time to name, so there is nothing to fix in
 * the console: the Bridge takes a book waiting for a worker on once one connects. */
export function parkEndsByItself(reason: ParkReason): boolean {
  return reason === 'worker';
}

/** How a job's status reads: its phase, the stage, the counts and ETA when known, the
 * park's reason and when it resumes by itself, the failure's text. */
export type JobStatusView =
  | { phase: 'waiting' | 'stopping' }
  | {
      phase: 'running';
      stage: GenerateStage;
      done?: number;
      total?: number;
      etaSeconds?: number;
    }
  | { phase: 'parked'; reason: ParkReason; retryAt?: Date }
  | { phase: 'failed'; error: string };

/** How `job` reads (see {@link JobStatusView}). Counts show only as a sane pair, an ETA
 * only when positive. */
export function jobStatusView(job: BridgeJob): JobStatusView {
  const p = job.progress;
  if (job.state === 'failed') return { phase: 'failed', error: job.error.trim() };
  if (job.cancel_requested) return { phase: 'stopping' };
  if (job.state === 'needs_attention') {
    const retry = p?.park?.retry_at ? new Date(p.park.retry_at) : undefined;
    return {
      phase: 'parked',
      reason: parkReason(p?.park?.code),
      retryAt: retry && Number.isFinite(retry.getTime()) ? retry : undefined,
    };
  }
  if (job.state !== 'running') return { phase: 'waiting' };
  const counted =
    typeof p?.done === 'number' &&
    typeof p.total === 'number' &&
    p.total > 0 &&
    p.done >= 0 &&
    p.done <= p.total;
  return {
    phase: 'running',
    stage: stageOf(p),
    ...(counted ? { done: p.done, total: p.total } : {}),
    ...(typeof p?.eta_seconds === 'number' && p.eta_seconds > 0
      ? { etaSeconds: p.eta_seconds }
      : {}),
  };
}

// --- Refusals -----------------------------------------------------------------------

/** The Bridge's refusals the player names, by the server's error code (each one of
 * `API_ERROR_CODES`, so `apiErrorKind` can answer it). */
const REFUSAL_KEY = {
  library_not_writable: 'bridge.generate.notWritable',
  kind_unavailable: 'bridge.generate.unavailable',
  // Bridge Phase 1d: the book's chapters are still being found (a `chapters.detect` job
  // queued or working); a generate job queued after it reuses its transcription.
  detect_open: 'bridge.generate.detectOpen',
  // Bridge Phase 2b: the book's characters and recaps are being shared with the community
  // (a `sidecars.contribute` job queued or working, queued from the console; a queued one
  // held while the module is off never refuses); a generate run would replace what is filed.
  contribute_open: 'bridge.generate.contributeOpen',
  // Bridge Phase 3c: the book's read-along is being made (a `readalong.align` job queued or
  // working); a generate run reuses its transcription after it.
  readalong_open: 'bridge.generate.readalongOpen',
} as const satisfies Partial<Record<ApiErrorCode, string>>;

/** A refusal's words (`REFUSAL_KEY`'s values). */
type RefusalKey = (typeof REFUSAL_KEY)[keyof typeof REFUSAL_KEY];

/** `REFUSAL_KEY` read by any kind `apiErrorKind` answers: a kind it doesn't name is absent. */
const REFUSAL_BY_KIND: Readonly<Partial<Record<ApiErrorKind, RefusalKey>>> = REFUSAL_KEY;

/** The open job kinds the server refuses a generate job for, with the words of the refusal
 * it answers (the server's `refusedWhileOpen` for `sidecars.generate`): a `chapters.detect`
 * job (Bridge Phase 1d, 409 `detect_open`), a `sidecars.contribute` job (Phase 2b, 409
 * `contribute_open`) and a `readalong.align` job (Phase 3c, 409 `readalong_open`). A kind
 * not named here holds nothing back. */
const OPEN_JOB_REFUSAL: Readonly<
  Record<string, (typeof REFUSAL_KEY)['detect_open' | 'contribute_open' | 'readalong_open']>
> = {
  [CHAPTERS_DETECT]: REFUSAL_KEY.detect_open,
  [SIDECARS_CONTRIBUTE]: REFUSAL_KEY.contribute_open,
  [READALONG_ALIGN]: REFUSAL_KEY.readalong_open,
};

/** The refusals about an open job of the refused book (`OPEN_JOB_REFUSAL`'s): their words
 * name that book ("This book's characters and recaps..."). */
const BOOK_REFUSALS: ReadonlySet<RefusalKey> = new Set(Object.values(OPEN_JOB_REFUSAL));

/** A Bridge refusal in the app's words (never the server's): the library it can't write,
 * the kind it doesn't offer, a book whose chapters are still being found or whose
 * characters and recaps are being shared, else `fallback`. `otherBook`: the refused book
 * isn't the one on screen (an earlier book of the series, queued first), so a refusal about
 * its own open job, worded as this book's, reads as `fallback` instead. */
export function bridgeRefusalKey<F extends string>(error: unknown, fallback: F, otherBook = false) {
  const key = REFUSAL_BY_KIND[apiErrorKind(error)];
  return key && !(otherBook && BOOK_REFUSALS.has(key)) ? key : fallback;
}

/** Why Generate is held back, when it is: the Bridge can't write the library (its
 * results would have nowhere to go), the estimate's `open_job` is a kind the server would
 * refuse a generate job for (`OPEN_JOB_REFUSAL`: the book's chapters are still being found,
 * or its characters and recaps are being shared with the community), or its agent is known
 * not to be signed in. Without the Bridge's figures (`figures`) `agent_ready` is only a
 * default, and the server queues the job anyway (it waits for the agent), so an unknown
 * readiness holds nothing back. */
export function blockedReason(
  e: Pick<BridgeEstimate, 'writable' | 'agent_ready' | 'figures' | 'open_job'>,
) {
  if (!e.writable) return REFUSAL_KEY.library_not_writable;
  const kind = e.open_job?.kind;
  if (kind && Object.hasOwn(OPEN_JOB_REFUSAL, kind)) return OPEN_JOB_REFUSAL[kind];
  if (e.figures === true && !e.agent_ready) return 'bridge.generate.agentNotReady' as const;
  return null;
}

/** A figure the estimate quotes, or null for none (null, missing or not a number). */
function figure(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** What the confirmation quotes for a run (see `runEstimate`). */
export type RunEstimate = {
  /** How many books the run queues (this one and the earlier ones it takes first). */
  books: number;
  /** Transcription hours in all: 0 when none is needed (an ebook), null when not known. */
  asrHours: number | null;
  /** The agent cost in all; null when any book has no estimate. */
  costUsd: number | null;
};

/**
 * What generating would take in all: this book's figures plus each earlier book's that
 * the confirmation queues first (`includeEarlier`, the books `queueOrder` adds), so the
 * quote covers every run the button starts. An audio book's 0 transcription hours means
 * "not known" (no figures, or the audio's length unknown), never "none"; an earlier book
 * is always read from its audio.
 */
export function runEstimate(
  e: Pick<
    BridgeEstimate,
    'library_id' | 'path' | 'source' | 'asr_hours' | 'agent_cost_usd' | 'earlier'
  >,
  includeEarlier: boolean,
): RunEstimate {
  const hoursOf = (v: number | undefined) => {
    const h = figure(v);
    return h !== null && h > 0 ? h : null;
  };
  let asrHours = e.source === 'ebook' ? 0 : hoursOf(e.asr_hours);
  let costUsd = figure(e.agent_cost_usd);
  const earlier = includeEarlier
    ? e.earlier.filter((b) => !(b.library_id === e.library_id && b.path === e.path))
    : [];
  for (const b of earlier) {
    const hours = hoursOf(b.asr_hours);
    asrHours = asrHours === null || hours === null ? null : asrHours + hours;
    const cost = figure(b.agent_cost_usd);
    costUsd = costUsd === null || cost === null ? null : costUsd + cost;
  }
  return { books: earlier.length + 1, asrHours, costUsd };
}
