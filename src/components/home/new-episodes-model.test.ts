import { podcastEpisode, podcastShow } from '@/testing/podcast-fixtures';

import { NEW_SHOWS, newEpisodes, recentShows } from './new-episodes-model';

const now = new Date('2026-10-22T12:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

describe('recentShows', () => {
  it('keeps the shows that published lately, newest first, at most eight', () => {
    const followed = [
      { connectionId: 'a', show: podcastShow({ path: 'Old', latest_published: daysAgo(20) }) },
      { connectionId: 'a', show: podcastShow({ path: 'Never', latest_published: null }) },
      { connectionId: 'a', show: podcastShow({ path: 'Week', latest_published: daysAgo(7) }) },
      { connectionId: 'b', show: podcastShow({ path: 'Today', latest_published: daysAgo(0) }) },
    ];
    expect(recentShows(followed, now).map((f) => f.show.path)).toEqual(['Today', 'Week']);
    const many = Array.from({ length: 12 }, (_, i) => ({
      connectionId: 'a',
      show: podcastShow({ path: `S${i}`, latest_published: daysAgo(i % 10) }),
    }));
    expect(recentShows(many, now)).toHaveLength(NEW_SHOWS);
  });
});

describe('newEpisodes', () => {
  const show = podcastShow();
  const ep = (path: string, over: Parameters<typeof podcastEpisode>[0] = {}) =>
    podcastEpisode({ path: `Daily News/${path}`, ...over });

  it('lists recent episodes newest first, without trailers, removed or started ones', () => {
    const episodes = [
      ep('a.mp3', { published: daysAgo(1) }),
      ep('b.mp3', { published: daysAgo(0) }),
      ep('trailer.mp3', { published: daysAgo(0), episode_type: 'trailer' }),
      ep('gone.mp3', { published: daysAgo(0), removed: true }),
      ep('old.mp3', { published: daysAgo(15) }),
      ep('undated.mp3', { published: null }),
      ep('started.mp3', { published: daysAgo(0) }),
      ep('bonus.mp3', { published: daysAgo(2), episode_type: 'bonus' }),
    ];
    const skip = new Set(['c1:5:Daily News/started.mp3']);
    const out = newEpisodes([{ connectionId: 'c1', show, episodes }], skip, now, 15);
    expect(out.map((e) => e.episode.path)).toEqual([
      'Daily News/b.mp3',
      'Daily News/a.mp3',
      'Daily News/bonus.mp3',
    ]);
    expect(out[0]).toMatchObject({ connectionId: 'c1', show, key: 'c1:5:Daily News/b.mp3' });
  });

  it('mixes shows and servers by date, breaks ties by key, and caps the shelf', () => {
    const same = daysAgo(1);
    const out = newEpisodes(
      [
        { connectionId: 'b', show, episodes: [ep('x.mp3', { published: same })] },
        { connectionId: 'a', show, episodes: [ep('x.mp3', { published: same })] },
        {
          connectionId: 'a',
          show: podcastShow({ path: 'Other', library_id: 6 }),
          episodes: [ep('new.mp3', { published: daysAgo(0) })],
        },
      ],
      new Set(),
      now,
      2,
    );
    expect(out.map((e) => e.key)).toEqual(['a:6:Daily News/new.mp3', 'a:5:Daily News/x.mp3']);
  });

  it('lists an episode once though two shows report it', () => {
    const e = ep('a.mp3', { published: daysAgo(1) });
    const out = newEpisodes(
      [
        { connectionId: 'a', show, episodes: [e] },
        { connectionId: 'a', show, episodes: [e] },
      ],
      new Set(),
      now,
      15,
    );
    expect(out).toHaveLength(1);
  });
});
