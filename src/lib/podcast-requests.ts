import type { PodcastRequest } from '@/api/types';

/** The follow-request states still on their way (the server's open job states): queued,
 * claimed by the Bridge, running, or parked for a person. Any other (done, failed,
 * cancelled, a state this build does not know) has ended. */
const OPEN_STATES: ReadonlySet<string> = new Set([
  'queued',
  'claimed',
  'running',
  'needs_attention',
]);

/** Whether a follow request (`GET /me/podcasts`'s `requests`) is still open. */
export function isOpenRequest(r: Pick<PodcastRequest, 'state'>): boolean {
  return OPEN_STATES.has(r.state);
}

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

/** The ids of the requests in `before` that were open and have ended `done` in `after`
 * (a request gone from `after` is not counted: nothing says how it ended). */
export function requestsDone(
  before: readonly PodcastRequest[] | undefined,
  after: readonly PodcastRequest[],
): PodcastRequest[] {
  if (!before) return [];
  const wasOpen = new Set(before.filter(isOpenRequest).map((r) => r.id));
  return after.filter((r) => wasOpen.has(r.id) && r.state === 'done');
}
