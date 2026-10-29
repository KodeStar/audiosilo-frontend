import type { ApiErrorCode } from '@/api/client';
import type { Book, ReadalongEstimate, ServerInfo, User } from '@/api/types';
import {
  CHAPTERS_DETECT,
  isOpenJob,
  READALONG_FEATURE,
  SIDECARS_GENERATE,
} from '@/lib/bridge-jobs';

// Who sees read-along, and when (Bridge Phase 3c, decision 29). Pure, so each rule is tested
// on its own; the surfaces (the companion's Text tab, the full-screen reader's Follow
// narration, the admin's Make read-along) read them.

/**
 * Whether a book's read-along can be followed here: its server serves maps (capability
 * `readalong`), the book's map is `ready` (a stale or absent one is invisible to a listener)
 * and the book reads (`readable`: `canRead`, which needs its ebook). The surface still waits
 * for the reader to say the map's spans resolve (`readalong {state: 'ok'}`) before it shows.
 */
export function readalongReady(
  readalong: boolean | undefined,
  book: Pick<Book, 'ebook' | 'readalong'> | undefined,
  readable: boolean,
): boolean {
  return (
    readalong === true &&
    readable &&
    !!book?.ebook &&
    book.readalong?.state === 'ready' &&
    typeof book.readalong.generated_at === 'string'
  );
}

/**
 * Whether this person may make a book's read-along on this server (decision 28): an admin
 * (never a household member, a kid's account or a demo account, whatever their role says)
 * on a server that serves maps, whose Bridge is online and offers `readalong`. An older
 * server has neither flag: never.
 */
export function mayMakeReadalong(
  user: Pick<User, 'role' | 'is_demo' | 'managed_by' | 'member_kind'> | null | undefined,
  server: Pick<ServerInfo, 'capabilities' | 'bridge'> | null | undefined,
): boolean {
  if (!user || !server) return false;
  if (user.role !== 'admin' || user.is_demo || user.managed_by || user.member_kind) return false;
  const caps = server.capabilities;
  return (
    caps?.bridge === true &&
    caps.readalong === true &&
    (server.bridge?.features ?? []).includes(READALONG_FEATURE)
  );
}

/** Why Make read-along is held back, as the server's refusal code it would answer. */
export type ReadalongBlock = Extract<
  ApiErrorCode,
  'no_ebook' | 'library_not_writable' | 'generate_open' | 'detect_open'
>;

/** The open job kinds the server refuses a read-along job for (its `refusedWhileOpen` for
 * `readalong.align`), with the code it answers. */
const OPEN_JOB_BLOCK: Readonly<Record<string, ReadalongBlock>> = {
  [SIDECARS_GENERATE]: 'generate_open',
  [CHAPTERS_DETECT]: 'detect_open',
};

/**
 * Why making a book's read-along is held back, from its estimate, else null: the book has
 * no ebook (409 `no_ebook`), the Bridge can't write the library (the map would have nowhere
 * to go), or a generate or detect job is open for the book (409 `generate_open` /
 * `detect_open`: one engine book per audio on the Bridge). The book's own open read-along
 * job holds nothing back here: its status shows instead.
 */
export function readalongBlockedReason(
  e: Pick<ReadalongEstimate, 'ebook' | 'writable' | 'open_job'>,
): ReadalongBlock | null {
  if (!e.ebook) return 'no_ebook';
  if (!e.writable) return 'library_not_writable';
  const job = e.open_job;
  if (job && isOpenJob(job) && Object.hasOwn(OPEN_JOB_BLOCK, job.kind)) {
    return OPEN_JOB_BLOCK[job.kind];
  }
  return null;
}
