import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import { qk } from './hooks';
import type { PodcastEpisode, PodcastEpisodePage } from './types';

/** A show's cached episode list: an order's pages (`usePodcastEpisodes`) or Home's one page
 * of the newest (`latestEpisodesQuery`). */
type EpisodeList = InfiniteData<PodcastEpisodePage> | PodcastEpisodePage;

/**
 * An episode its server has now (a fetch it waited for ended `ready`, fe#280): the show's
 * cached episode lists (both orders, Home's newest) say so, at `size` bytes, instead of every
 * list being read again for the one row. A list that does not hold the episode is left as it
 * is, and one not cached is read when it is next shown, as before.
 */
export function markEpisodeOnServer(
  qc: QueryClient,
  connectionId: string,
  libraryId: number,
  show: string,
  path: string,
  size: number,
): void {
  const onServer = (page: PodcastEpisodePage): PodcastEpisodePage => {
    if (!page.episodes.some((ep) => ep.path === path)) return page;
    const episodes = page.episodes.map((ep): PodcastEpisode => {
      if (ep.path !== path) return ep;
      const { fetch: _fetched, ...rest } = ep;
      return { ...rest, downloaded: true, size };
    });
    return { ...page, episodes };
  };
  qc.setQueriesData<EpisodeList>(
    { queryKey: qk.podcastEpisodesOfShow(connectionId, libraryId, show) },
    (list) => {
      if (!list) return list;
      if ('pages' in list) {
        const pages = list.pages.map(onServer);
        return pages.every((p, i) => p === list.pages[i]) ? list : { ...list, pages };
      }
      return onServer(list);
    },
  );
}
