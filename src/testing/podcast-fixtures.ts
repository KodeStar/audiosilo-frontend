import type {
  Book,
  PodcastEpisode,
  PodcastEpisodeInfo,
  PodcastFetchStatus,
  PodcastShow,
} from '@/api/types';

import wire from './podcast-fixtures/wire-2b.json';

/**
 * Podcast fixtures (Bridge Phase 2d-1). `wire` is the server's own golden
 * (`internal/podcast/testdata/phase2c2/wire-2b.json`, copied byte for byte): the fetch
 * statuses and the `/stream` 503 body exactly as the server sends them.
 */
export const wire2b = wire as {
  status_response: { fetch: PodcastFetchStatus };
  stream_response: { error: string; code: string; fetch: PodcastFetchStatus };
  ready: PodcastFetchStatus;
  failed: PodcastFetchStatus;
};

/** A followed, episodic show with every field the server sends. */
export function podcastShow(over: Partial<PodcastShow> = {}): PodcastShow {
  return {
    library_id: 5,
    path: 'Daily News',
    title: 'Daily News',
    author: 'The Newsroom',
    description: 'The news, every morning.',
    link: 'https://news.example/',
    language: 'en',
    type: 'episodic',
    explicit: false,
    private: false,
    feed_url: 'https://news.example/feed.xml',
    feed_host: 'news.example',
    podcast_guid: 'guid-daily',
    episode_count: 8,
    latest_published: '2026-10-21T06:00:00Z',
    cover_version: 'cv1',
    following: true,
    status: { last_checked: null, last_success: null, next_check: null, error: null },
    retention: { mode: 'keep', keep: 3, days: 7 },
    ...over,
  };
}

/** An episode row on the server (downloaded unless `over` says otherwise). */
export function podcastEpisode(over: Partial<PodcastEpisode> = {}): PodcastEpisode {
  return {
    path: 'Daily News/2026-10-21 Monday.mp3',
    title: 'Monday',
    published: '2026-10-21T06:00:00Z',
    duration: 1800,
    duration_source: 'file',
    season: null,
    episode: 12,
    episode_type: 'full',
    explicit: false,
    description: 'What happened on Monday.',
    downloaded: true,
    size: 16493,
    removed: false,
    ...over,
  };
}

/** A fetch status, `fetching` (the golden's) unless `over` says otherwise. */
export function fetchStatus(over: Partial<PodcastFetchStatus> = {}): PodcastFetchStatus {
  return { ...wire2b.status_response.fetch, ...over };
}

/** An item that is an episode (`GET /libraries/{id}/item`), not on the server unless
 * `episode` says otherwise. */
export function episodeBook(
  over: Partial<Book> = {},
  episode: Partial<PodcastEpisodeInfo> = {},
): Book {
  return {
    id: 90,
    library_id: 5,
    rel_path: 'Daily News/2026-10-21 Monday.mp3',
    is_folder: false,
    title: 'Monday',
    author: 'The Newsroom',
    series: '',
    series_index: 0,
    narrator: '',
    duration: 1800,
    format: 'mp3',
    size: 0,
    direct_playable: true,
    episode: {
      show_path: 'Daily News',
      published: '2026-10-21T06:00:00Z',
      season: null,
      episode: 12,
      episode_type: 'full',
      explicit: false,
      downloaded: false,
      duration_source: 'feed',
      removed: false,
      ...episode,
    },
    ...over,
  };
}
