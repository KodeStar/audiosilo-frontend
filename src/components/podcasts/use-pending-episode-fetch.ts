import { contentKey } from '@/lib/content-key';
import { type PendingEpisodeFetch, useEpisodeFetch } from '@/playback/episode-fetch';

/** The player's fetch of this episode when it is the one on its way, else null. One rule for
 * the episode row, the episode page and an episode's "..." menu, so they read the same
 * state; a caller re-renders only when its own episode's fetch changes. */
export function usePendingEpisodeFetch(
  connectionId: string,
  libraryId: number,
  path: string,
): PendingEpisodeFetch | null {
  const key = contentKey(connectionId, libraryId, path);
  return useEpisodeFetch((s) => (s.pending?.key === key ? s.pending : null));
}
