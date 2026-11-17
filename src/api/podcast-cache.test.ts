import { type InfiniteData, QueryClient } from '@tanstack/react-query';

import { episodeBook, fetchStatus, podcastEpisode } from '@/testing/podcast-fixtures';

import { qk } from './hooks';
import { markEpisodeOnServer } from './podcast-cache';
import type { PodcastEpisodePage } from './types';

describe('markEpisodeOnServer (fe#280)', () => {
  const path = 'Daily News/2026-10-21 Monday.mp3';
  const absent = podcastEpisode({
    downloaded: false,
    size: 0,
    duration: 0,
    duration_source: 'none',
    fetch: fetchStatus(),
  });
  const other = podcastEpisode({ path: 'Daily News/Tuesday.mp3', downloaded: false, size: 0 });
  const page = (episodes = [absent, other]): PodcastEpisodePage => ({
    episodes,
    next_cursor: null,
  });

  it('marks the one episode on its server in every cached list of its show, reading none again', () => {
    const qc = new QueryClient();
    const newest = qk.podcastEpisodes('c1', 5, 'Daily News', 'newest');
    const latest = qk.latestEpisodes('c1', 5, 'Daily News', 6);
    const elsewhere = qk.podcastEpisodes('c1', 5, 'Other Show', 'newest');
    qc.setQueryData<InfiniteData<PodcastEpisodePage>>(newest, {
      pages: [page([other]), page([absent])],
      pageParams: [undefined, 'next'],
    });
    qc.setQueryData(latest, page());
    qc.setQueryData(elsewhere, page());
    const invalidate = jest.spyOn(qc, 'invalidateQueries');

    // Its item, read once it was there: the file's own size and length.
    const item = episodeBook(
      { size: 16493, duration: 1800 },
      { downloaded: true, duration_source: 'file' },
    );
    markEpisodeOnServer(qc, 'c1', 5, 'Daily News', path, item);

    const pages = qc.getQueryData<InfiniteData<PodcastEpisodePage>>(newest)!.pages;
    expect(pages[0].episodes).toEqual([other]);
    expect(pages[1].episodes[0]).toEqual({ ...podcastEpisode(), downloaded: true, size: 16493 });
    expect(pages[1].episodes[0]).not.toHaveProperty('fetch');
    const rail = qc.getQueryData<PodcastEpisodePage>(latest)!;
    expect(rail.episodes[0].downloaded).toBe(true);
    expect(rail.episodes[1]).toBe(other);
    // Another show's list, and the cache's reads, untouched.
    expect(qc.getQueryData<PodcastEpisodePage>(elsewhere)!.episodes[0]).toBe(absent);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('leaves a list that does not hold the episode as it is', () => {
    const qc = new QueryClient();
    const key = qk.latestEpisodes('c1', 5, 'Daily News', 6);
    const list = page([other]);
    qc.setQueryData(key, list);
    markEpisodeOnServer(qc, 'c1', 5, 'Daily News', path, episodeBook());
    expect(qc.getQueryData(key)).toBe(list);
  });
});
