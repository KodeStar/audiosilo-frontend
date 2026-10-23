import i18n from '@/i18n';
import { fetchStatus, podcastEpisode, podcastShow, wire2b } from '@/testing/podcast-fixtures';

import {
  defaultEpisodeOrder,
  episodeAsBook,
  episodeLabel,
  episodeMarks,
  episodeMetaLine,
  episodeRowState,
  fetchProgress,
  fetchReasonKey,
  isRecent,
  rowStateReasonKey,
  visibleEpisodes,
} from './podcast-model';

const t = i18n.t.bind(i18n);

describe('fetchReasonKey', () => {
  it("names a listener's sentence for each known code, else the generic one", () => {
    for (const code of [
      'module_off',
      'bridge_unavailable',
      'library_not_writable',
      'fetch_limit',
      'demo_account',
      'too_large',
      'identity_changed',
    ]) {
      expect(fetchReasonKey(code)).toBe(`podcasts.fetch.reason.${code}`);
    }
    expect(fetchReasonKey('http_404')).toBe('podcasts.fetch.reason.other');
    expect(fetchReasonKey(null)).toBe('podcasts.fetch.reason.other');
    expect(fetchReasonKey(undefined)).toBe('podcasts.fetch.reason.other');
  });
});

describe('fetchProgress', () => {
  it('is the bytes so far and the share done, when the size is known', () => {
    expect(fetchProgress(wire2b.status_response.fetch)).toEqual({
      received: 100,
      total: 1000,
      percent: 10,
    });
    expect(fetchProgress(fetchStatus({ bytes_received: 2000 }))).toMatchObject({ percent: 100 });
  });

  it('has no share without a size, or without a status', () => {
    expect(fetchProgress(fetchStatus({ bytes_total: null }))).toEqual({
      received: 100,
      total: null,
      percent: null,
    });
    expect(fetchProgress(fetchStatus({ bytes_total: 0 }))).toMatchObject({ percent: null });
    expect(fetchProgress(null)).toEqual({ received: 0, total: null, percent: null });
  });
});

describe('defaultEpisodeOrder', () => {
  it('reads a serial show from its first episode, any other newest first', () => {
    expect(defaultEpisodeOrder({ type: 'serial' })).toBe('oldest');
    expect(defaultEpisodeOrder({ type: 'episodic' })).toBe('newest');
    expect(defaultEpisodeOrder({ type: 'mini-series' })).toBe('newest');
    expect(defaultEpisodeOrder(undefined)).toBe('newest');
  });
});

describe('episodeMarks', () => {
  it('lists Trailer or Bonus, then Explicit', () => {
    expect(episodeMarks({ episode_type: 'trailer', explicit: true }, t)).toEqual([
      'Trailer',
      'Explicit',
    ]);
    expect(episodeMarks({ episode_type: 'bonus', explicit: false }, t)).toEqual(['Bonus']);
    expect(episodeMarks({ episode_type: 'full', explicit: false }, t)).toEqual([]);
  });
});

describe('episodeLabel', () => {
  it('numbers a season and episode, an episode alone, or nothing', () => {
    expect(episodeLabel({ season: 2, episode: 5 }, t)).toBe('S2 E5');
    expect(episodeLabel({ season: null, episode: 5 }, t)).toBe('E5');
    expect(episodeLabel({ season: 2, episode: null }, t)).toBeNull();
  });

  it('builds the meta line from what the feed says', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    expect(
      episodeMetaLine(
        podcastEpisode({ published: '2026-10-21T06:00:00Z', season: 1, episode: 3 }),
        t,
        now,
      ),
    ).toMatch(/^(21 Oct|Oct 21) · 30m · S1 E3$/);
    // An unknown length is not "0m"; an undated episode has no date.
    expect(
      episodeMetaLine(
        podcastEpisode({ published: null, duration: 0, duration_source: 'none', episode: null }),
        t,
        now,
      ),
    ).toBe('');
  });
});

describe('visibleEpisodes', () => {
  it('drops an episode gone from the feed unless its file is kept', () => {
    const kept = podcastEpisode({ path: 'a', removed: true, downloaded: true });
    const gone = podcastEpisode({ path: 'b', removed: true, downloaded: false });
    const live = podcastEpisode({ path: 'c', downloaded: false });
    expect(visibleEpisodes([kept, gone, live])).toEqual([kept, live]);
  });
});

describe('isRecent', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  it('is within the last two weeks', () => {
    expect(isRecent('2026-10-21T06:00:00Z', now)).toBe(true);
    expect(isRecent('2026-10-01T06:00:00Z', now)).toBe(false);
    expect(isRecent(null, now)).toBe(false);
    expect(isRecent('not a date', now)).toBe(false);
  });
});

describe('episodeRowState', () => {
  const absent = podcastEpisode({ downloaded: false });
  it('reads the file on the server as ready, an absent one as on demand', () => {
    expect(episodeRowState(podcastEpisode(), null, true)).toEqual({ kind: 'ready' });
    expect(episodeRowState(absent, null, true)).toEqual({ kind: 'onDemand' });
    // A server that cannot fetch it: not available.
    expect(episodeRowState(absent, null, false)).toEqual({
      kind: 'unavailable',
      code: 'bridge_unavailable',
    });
  });

  it("follows the list's batched status", () => {
    expect(episodeRowState({ ...absent, fetch: wire2b.status_response.fetch }, null, true)).toEqual(
      {
        kind: 'getting',
        percent: 10,
      },
    );
    expect(episodeRowState({ ...absent, fetch: wire2b.failed }, null, true)).toEqual({
      kind: 'failed',
      code: wire2b.failed.error?.code ?? null,
    });
    expect(
      episodeRowState({ ...absent, fetch: fetchStatus({ state: 'unavailable' }) }, null, true),
    ).toEqual({ kind: 'unavailable', code: null });
    expect(
      episodeRowState(
        {
          ...absent,
          fetch: fetchStatus({
            state: 'unavailable',
            error: { code: 'library_not_writable', message: 'read-only mount' },
          }),
        },
        null,
        true,
      ),
    ).toEqual({ kind: 'unavailable', code: 'library_not_writable' });
  });

  it("prefers the player's own fetch of the episode", () => {
    const waiting = {
      phase: 'waiting' as const,
      status: fetchStatus({ bytes_received: 500 }),
      code: null,
    };
    expect(episodeRowState(absent, waiting, true)).toEqual({ kind: 'getting', percent: 50 });
    expect(
      episodeRowState(absent, { phase: 'refused', status: null, code: 'fetch_limit' }, true),
    ).toEqual({ kind: 'failed', code: 'fetch_limit' });
    expect(
      episodeRowState(absent, { phase: 'unavailable', status: null, code: 'module_off' }, true),
    ).toEqual({ kind: 'unavailable', code: 'module_off' });
    expect(episodeRowState(absent, { phase: 'probing', status: null, code: null }, true)).toEqual({
      kind: 'getting',
      percent: null,
    });
  });
});

describe('rowStateReasonKey', () => {
  it('names why only for a stopped row', () => {
    expect(rowStateReasonKey({ kind: 'failed', code: null })).toBe(fetchReasonKey(null));
    expect(rowStateReasonKey({ kind: 'unavailable', code: 'bridge_unavailable' })).toBe(
      fetchReasonKey('bridge_unavailable'),
    );
    expect(rowStateReasonKey({ kind: 'ready' })).toBeNull();
    expect(rowStateReasonKey({ kind: 'getting', percent: 10 })).toBeNull();
  });
});

describe('episodeAsBook', () => {
  it("is the episode as a start takes it, with the show's author and its facts", () => {
    const b = episodeAsBook(
      podcastEpisode({ downloaded: false, fetch: wire2b.failed }),
      podcastShow(),
    );
    expect(b).toMatchObject({
      library_id: 5,
      rel_path: 'Daily News/2026-10-21 Monday.mp3',
      title: 'Monday',
      author: 'The Newsroom',
      episode: { show_path: 'Daily News', downloaded: false, fetch: wire2b.failed },
    });
  });
});
