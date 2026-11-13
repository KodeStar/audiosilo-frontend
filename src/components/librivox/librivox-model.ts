import { apiErrorKind } from '@/api/client';
import type { BridgeJob, LibrivoxFetchResult, MetaPersonRef, ServerInfo, User } from '@/api/types';
import {
  isBridgeAdmin,
  isOpenJob,
  LIBRIVOX_FEATURE,
  LIBRIVOX_FETCH,
  progressCounts,
} from '@/lib/bridge-jobs';

// Find on LibriVox (LibriVox L6): who may add a LibriVox recording from the player, how a
// recording's fetch reads and the refusals' words. Pure, so each rule is tested on its own.
// The console's Library > LibriVox (audiosilo-server admin-ui `features/librivox`) is the
// same page; this one follows its rules.

/**
 * Who may open Find on LibriVox on a server, and why not:
 * - `unknown` while its `/server` answer is not in;
 * - `notAdmin` for anyone but an admin (`isBridgeAdmin`: never a household member, a kid's
 *   account or a demo account, whatever their role says);
 * - `unavailable` while its Bridge is not online with `librivox` (the only sign a server
 *   has the L6 routes: an older server, an older Bridge, no Bridge, or one offline, since
 *   `/server` names the Bridge's features only while it is online);
 * - `metadataOff` while community metadata is off (the routes answer 404 `metadata_off`);
 * - `allowed`.
 */
export type LibrivoxAccess = 'unknown' | 'notAdmin' | 'unavailable' | 'metadataOff' | 'allowed';

export function librivoxAccess(
  user: Pick<User, 'role' | 'is_demo' | 'managed_by' | 'member_kind'> | null | undefined,
  server: Pick<ServerInfo, 'capabilities' | 'bridge'> | null | undefined,
): LibrivoxAccess {
  if (!isBridgeAdmin(user)) return 'notAdmin';
  if (!server) return 'unknown';
  const caps = server.capabilities;
  if (caps?.bridge !== true || !(server.bridge?.features ?? []).includes(LIBRIVOX_FEATURE)) {
    return 'unavailable';
  }
  return caps.metadata === true ? 'allowed' : 'metadataOff';
}

/** Whether a books library offers Find on LibriVox: `librivoxAccess` is `allowed`.
 * Nothing at all for anyone else, and nothing on an older server. */
export function mayAddLibrivox(
  user: Parameters<typeof librivoxAccess>[0],
  server: Parameters<typeof librivoxAccess>[1],
): boolean {
  return librivoxAccess(user, server) === 'allowed';
}

/** Names as one line ("A, B"), the empty string for none. */
export function namesLine(people: readonly MetaPersonRef[] | null | undefined) {
  return (people ?? [])
    .map((p) => p.name.trim())
    .filter(Boolean)
    .join(', ');
}

// --- How a fetch reads ----------------------------------------------------------------

/** The Bridge's steps of a `librivox.fetch` the player has words for. */
const STEPS = ['manifest', 'download', 'cover', 'place', 'rescan'] as const;
export type LibrivoxStep = (typeof STEPS)[number] | 'working';

/** The failure (and park) codes a `librivox.fetch` may name (the Bridge's). */
const FETCH_CODES = [
  'not_writable',
  'exists',
  'disk_full',
  'not_found',
  'archive_unavailable',
  'metadata_off',
] as const;
export type LibrivoxFetchCode = (typeof FETCH_CODES)[number] | 'other';

const knownCode = (code: unknown): LibrivoxFetchCode | undefined =>
  typeof code === 'string' && (FETCH_CODES as readonly string[]).includes(code)
    ? (code as LibrivoxFetchCode)
    : undefined;

/** Why a fetch stopped: a park's code, else the result's code, else an error that starts
 * with one (`exists: ...`); `other` for any other (the Bridge's English is never shown). */
export function fetchCode(
  job: Pick<BridgeJob, 'state' | 'progress' | 'result' | 'error'>,
): LibrivoxFetchCode {
  if (job.state === 'needs_attention') return knownCode(job.progress?.park?.code) ?? 'other';
  const own = (job.result as LibrivoxFetchResult | null)?.code;
  if (typeof own === 'string' && own) return knownCode(own) ?? 'other';
  return FETCH_CODES.find((c) => job.error === c || job.error.startsWith(`${c}:`)) ?? 'other';
}

/** How a recording's fetch reads (`fetchView`). */
export type FetchView =
  | { phase: 'waiting' | 'stopping' }
  | { phase: 'running'; step: LibrivoxStep; done?: number; total?: number }
  | { phase: 'parked' | 'failed'; code: LibrivoxFetchCode }
  | { phase: 'cancelled' | 'done' };

/** How `job` reads: waiting (queued, or claimed and not started), stopping (a cancel
 * asked), running with its step and the sections done when sane, parked or failed with its
 * code, cancelled, done. */
export function fetchView(job: BridgeJob): FetchView {
  switch (job.state) {
    case 'done':
      return { phase: 'done' };
    case 'cancelled':
      return { phase: 'cancelled' };
    case 'failed':
      return { phase: 'failed', code: fetchCode(job) };
  }
  if (job.cancel_requested) return { phase: 'stopping' };
  if (job.state === 'needs_attention') return { phase: 'parked', code: fetchCode(job) };
  const p = job.progress;
  if (job.state !== 'running' || !p?.step) return { phase: 'waiting' };
  const step = (STEPS as readonly string[]).includes(p.step) ? (p.step as LibrivoxStep) : 'working';
  return { phase: 'running', step, ...progressCounts(p) };
}

/**
 * What a recording row shows (`rowState`): `inLibrary` once the server holds it (the work
 * names a book), else its followed job while that is open or ended without adding it
 * (`job`: failed or cancelled say why, with Add back), else `add`. A job read `done` before
 * the work names the book is `job` too (its "Added" line), until the work catches up.
 */
export function rowState(
  inLibrary: boolean,
  job: BridgeJob | undefined,
  workSaysOpen: boolean,
): 'inLibrary' | 'job' | 'opening' | 'add' {
  if (inLibrary) return 'inLibrary';
  if (job && job.kind === LIBRIVOX_FETCH) return 'job';
  // The work names an open job this row has not read yet.
  if (workSaysOpen) return 'opening';
  return 'add';
}

/** Whether a row offers Add: with nothing else to show (`add`), or under a followed job
 * that ended without adding the book (failed or cancelled: it says why, with Add back).
 * Never while that job is open, nor once it is done (the work is about to name the book). */
export function offersAdd(state: ReturnType<typeof rowState>, job: BridgeJob | undefined) {
  if (state === 'add') return true;
  return state === 'job' && !!job && !isOpenJob(job) && job.state !== 'done';
}

/**
 * How long after a fetch reads done its work is asked once more: the server records the
 * placed book as the recording just after the job ends, so the first answer can still miss
 * it.
 */
export const DONE_RECHECK_MS = 2000;

// --- Refusals -------------------------------------------------------------------------

/** An Add's refusal in the app's words (never the server's English). */
export function addRefusalKey(error: unknown) {
  switch (apiErrorKind(error)) {
    case 'in_library':
      return 'librivox.add.inLibrary' as const;
    case 'not_book_library':
      return 'librivox.add.notBookLibrary' as const;
    case 'kind_unavailable':
      return 'librivox.add.unavailable' as const;
    case 'library_not_writable':
      return 'librivox.add.notWritable' as const;
    case 'metadata_off':
      return 'librivox.add.metadataOff' as const;
    case 'not_found':
      return 'librivox.add.notFound' as const;
    default:
      return 'librivox.add.failed' as const;
  }
}

/** A failed read (a search, a work) in the app's words: community metadata turned off
 * meanwhile, a query the server refuses, else the metadata service could not answer. */
export function readErrorKey(error: unknown) {
  switch (apiErrorKind(error)) {
    case 'metadata_off':
      return 'librivox.errors.metadataOff' as const;
    case 'invalid':
      return 'librivox.errors.invalid' as const;
    case 'not_found':
      return 'librivox.errors.notFound' as const;
    default:
      return 'librivox.errors.failed' as const;
  }
}
