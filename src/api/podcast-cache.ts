import type { InfiniteData, QueryClient, QueryState } from '@tanstack/react-query';

import { qk } from './hooks';
import type { Book, PodcastEpisode, PodcastEpisodePage } from './types';

/** A show's cached episode list: an order's pages (`usePodcastEpisodes`) or Home's one page
 * of the newest (`latestEpisodesQuery`). */
type EpisodeList = InfiniteData<PodcastEpisodePage> | PodcastEpisodePage;

/**
 * An episode its server has now (a fetch it waited for ended `ready`, fe#280): the show's
 * cached episode lists (both orders, Home's newest) say so, with what `book` (its item, read
 * once it was there) says of the file (its size and length), instead of every list being
 * read again for the one row. A list that does not hold the episode is left as it is, and one
 * not cached is read when it is next shown, as before. An item that does not say the episode
 * is there (its read failed: the cache's older answer) has nothing to mark the lists with:
 * they are read again instead.
 */
export function markEpisodeOnServer(
  qc: QueryClient,
  connectionId: string,
  libraryId: number,
  show: string,
  path: string,
  book: Book,
): void {
  const queryKey = qk.podcastEpisodesOfShow(connectionId, libraryId, show);
  const info = book.episode;
  if (!info?.downloaded) {
    void qc.invalidateQueries({ queryKey });
    return;
  }
  const onServer = (page: PodcastEpisodePage): PodcastEpisodePage => {
    if (!page.episodes.some((ep) => ep.path === path)) return page;
    const episodes = page.episodes.map((ep): PodcastEpisode => {
      if (ep.path !== path) return ep;
      const { fetch: _fetched, ...rest } = ep;
      return {
        ...rest,
        downloaded: true,
        size: book.size,
        duration: book.duration,
        duration_source: info.duration_source,
      };
    });
    return { ...page, episodes };
  };
  for (const query of qc.getQueryCache().findAll({ queryKey })) {
    const { data: list, dataUpdatedAt, isInvalidated } = query.state as QueryState<EpisodeList>;
    if (!list) continue;
    let marked: EpisodeList;
    if ('pages' in list) {
      const pages = list.pages.map(onServer);
      marked = pages.every((p, i) => p === list.pages[i]) ? list : { ...list, pages };
    } else {
      marked = onServer(list);
    }
    if (marked === list) continue;
    // One row marked is not the list read again: it keeps its date (and a read a write left
    // it waiting for), so it is refreshed exactly when it would have been (`keepFirstPage`).
    qc.setQueryData<EpisodeList>(query.queryKey, marked, { updatedAt: dataUpdatedAt });
    if (isInvalidated) {
      void qc.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: 'none' });
    }
  }
}
