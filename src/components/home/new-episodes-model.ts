import type { PodcastEpisode, PodcastShow } from '@/api/types';
import { isRecent } from '@/components/podcasts/podcast-model';
import { contentKey } from '@/lib/content-key';

/** How many followed shows Home asks for their latest episodes. */
export const NEW_SHOWS = 8;

/** How many of a show's newest episodes Home asks for. */
export const NEW_EPISODES_PER_SHOW = 5;

/** A followed show on one server. */
export type FollowedShow = { connectionId: string; show: PodcastShow };

/** One tile of Home's New episodes. */
export type NewEpisode = FollowedShow & { episode: PodcastEpisode; key: string };

/** The followed shows worth asking about: published something in the last
 * 14 days (`NEW_EPISODE_DAYS`), newest first, at most {@link NEW_SHOWS}. */
export function recentShows(followed: readonly FollowedShow[], now: Date): FollowedShow[] {
  return followed
    .filter((f) => isRecent(f.show.latest_published, now))
    .sort(
      (a, b) =>
        Date.parse(b.show.latest_published ?? '') - Date.parse(a.show.latest_published ?? '') ||
        a.connectionId.localeCompare(b.connectionId) ||
        a.show.path.localeCompare(b.show.path),
    )
    .slice(0, NEW_SHOWS);
}

/**
 * Home's New episodes: each show's newest episodes published in the last
 * 14 days (`NEW_EPISODE_DAYS`), without trailers or ones gone from the feed, and without any
 * already started or finished (`skip`, content keys: Continue listening has those).
 * Newest first, then by key, at most `limit`.
 */
export function newEpisodes(
  shows: readonly (FollowedShow & { episodes: readonly PodcastEpisode[] })[],
  skip: ReadonlySet<string>,
  now: Date,
  limit: number,
): NewEpisode[] {
  const seen = new Set<string>();
  const out: NewEpisode[] = [];
  for (const { connectionId, show, episodes } of shows) {
    for (const episode of episodes) {
      const key = contentKey(connectionId, show.library_id, episode.path);
      if (seen.has(key) || skip.has(key)) continue;
      if (episode.removed || episode.episode_type === 'trailer') continue;
      if (!isRecent(episode.published, now)) continue;
      seen.add(key);
      out.push({ connectionId, show, episode, key });
    }
  }
  const at = (e: NewEpisode) => Date.parse(e.episode.published ?? '');
  return out
    .sort((a, b) => at(b) - at(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, limit);
}
