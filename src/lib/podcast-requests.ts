import type { PodcastRequest } from '@/api/types';
import { isOpenJob } from '@/lib/bridge-jobs';

/** Whether a follow request (`GET /me/podcasts`'s `requests`) is still open: a follow
 * request is a Bridge job, so its open states are the jobs' (queued, claimed, running, or
 * parked for a person). Any other (done, failed, cancelled, a state this build does not
 * know) has ended. */
export const isOpenRequest: (r: Pick<PodcastRequest, 'state'>) => boolean = isOpenJob;

/** How often a screen showing follow requests reads them again while one is open. */
export const FOLLOW_REQUEST_POLL_MS = 5_000;

/** A library's follow requests as a list shows them: the open ones first, then the
 * ended, each newest first (by `created_at`, then id). `libraryId` undefined keeps
 * every library's. */
export function libraryRequests(
  requests: readonly PodcastRequest[],
  libraryId?: number,
): PodcastRequest[] {
  return requests
    .filter((r) => libraryId === undefined || r.library_id === libraryId)
    .sort(
      (a, b) =>
        Number(isOpenRequest(b)) - Number(isOpenRequest(a)) ||
        b.created_at.localeCompare(a.created_at) ||
        b.id - a.id,
    );
}

/** The requests of `after` that were open in `before` and have ended `done`
 * (a request gone from `after` is not counted: nothing says how it ended). */
export function requestsDone(
  before: readonly PodcastRequest[] | undefined,
  after: readonly PodcastRequest[],
): PodcastRequest[] {
  if (!before) return [];
  const wasOpen = new Set(before.filter(isOpenRequest).map((r) => r.id));
  return after.filter((r) => wasOpen.has(r.id) && r.state === 'done');
}
