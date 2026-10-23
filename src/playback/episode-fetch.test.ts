import { AppState } from 'react-native';

let mockClient: Record<string, jest.Mock> | null;
jest.mock('@/api/connection-clients', () => ({ resolveClient: () => mockClient }));
jest.mock('@/api/provider', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({}),
);
const mockStart = jest.fn();
jest.mock('@/components/player/start-book', () => ({
  startBookInPlace: (...a: unknown[]) => mockStart(...a),
}));

/* eslint-disable import/first */
import { ApiError, PodcastFetchPendingError } from '@/api/client';
import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { PodcastFetchStatus } from '@/api/types';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';
import { episodeBook, fetchStatus, wire2b } from '@/testing/podcast-fixtures';

import {
  blipDelay,
  cancelEpisodeFetch,
  cancelEpisodeFetchOf,
  cancelEpisodeFetchUnless,
  isEpisodeFetchStarting,
  isLatestStart,
  needsEpisodeFetch,
  requestEpisodeFetch,
  retryEpisodeFetch,
  useEpisodeFetch,
} from './episode-fetch';
/* eslint-enable import/first */

const target = { connectionId: 'c1', libraryId: 5, path: 'Daily News/2026-10-21 Monday.mp3' };
const book = episodeBook();

const pending503 = (status: PodcastFetchStatus = wire2b.stream_response.fetch, wait = 2) =>
  new PodcastFetchPendingError('Episode is being fetched.', 'podcast_fetching', status, wait);

let appState: string;
let appListeners: ((s: string) => void)[];
const emitAppState = (s: string) => {
  appState = s;
  [...appListeners].forEach((l) => l(s));
};

/** Let the controller's awaits run (no time passes). */
const flush = () => jest.advanceTimersByTimeAsync(0);
const phase = () => useEpisodeFetch.getState().pending?.phase;

beforeEach(() => {
  jest.useFakeTimers();
  queryClient.clear();
  mockClient = {
    prepareEpisodeStream: jest.fn().mockRejectedValue(pending503()),
    podcastFetchStatus: jest.fn().mockResolvedValue({ fetch: wire2b.status_response.fetch }),
    retryPodcastFetch: jest.fn().mockResolvedValue({ fetch: fetchStatus({ state: 'queued' }) }),
    item: jest.fn().mockResolvedValue(episodeBook({}, { downloaded: true })),
    chapters: jest.fn().mockResolvedValue({ chapters: [], files: [] }),
  };
  mockStart.mockReset().mockResolvedValue(true);
  appState = 'active';
  appListeners = [];
  Object.defineProperty(AppState, 'currentState', { get: () => appState, configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _: string,
    l: (s: string) => void,
  ) => {
    appListeners.push(l);
    return { remove: () => (appListeners = appListeners.filter((x) => x !== l)) };
  }) as unknown as typeof AppState.addEventListener);
});

afterEach(() => {
  cancelEpisodeFetch();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('needsEpisodeFetch', () => {
  it('is an episode not on its server, on a server that fetches on demand', () => {
    expect(needsEpisodeFetch(book, true)).toBe(true);
    expect(needsEpisodeFetch(book, false)).toBe(false);
    expect(needsEpisodeFetch(book, undefined)).toBe(false);
    expect(needsEpisodeFetch(episodeBook({}, { downloaded: true }), true)).toBe(false);
    expect(needsEpisodeFetch({ ...book, episode: undefined }, true)).toBe(false);
  });
});

describe('requestEpisodeFetch', () => {
  it('starts once, fetched, when the stream answers at once', async () => {
    mockClient!.prepareEpisodeStream.mockResolvedValue(undefined);
    requestEpisodeFetch(target, book, { position: 30 });
    expect(phase()).toBe('probing');
    await flush();
    expect(mockStart.mock.calls).toEqual([[target, { position: 30 }, { fetched: true }]]);
    expect(useEpisodeFetch.getState().pending).toBeNull();
    expect(mockClient!.podcastFetchStatus).not.toHaveBeenCalled();
    expect(mockClient!.retryPodcastFetch).not.toHaveBeenCalled();
  });

  it('follows the fetch every 2 s, then reads the item again and starts once', async () => {
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const seed = jest.spyOn(queryClient, 'setQueryData');
    requestEpisodeFetch(target, book);
    await flush();
    expect(phase()).toBe('waiting');
    expect(useEpisodeFetch.getState().pending?.status).toEqual(wire2b.stream_response.fetch);
    // Seeded for the episode page and rows.
    expect(seed).toHaveBeenCalledWith(
      qk.podcastFetch('c1', 5, target.path),
      wire2b.stream_response.fetch,
    );
    await jest.advanceTimersByTimeAsync(1999);
    expect(mockClient!.podcastFetchStatus).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockClient!.podcastFetchStatus).toHaveBeenCalledTimes(1);
    expect(phase()).toBe('waiting');

    mockClient!.podcastFetchStatus.mockResolvedValue({ fetch: wire2b.ready });
    await jest.advanceTimersByTimeAsync(2000);
    expect(mockClient!.item).toHaveBeenCalledTimes(1);
    expect(mockClient!.chapters).toHaveBeenCalledTimes(1);
    // Read again: a show page or Home's rail on screen shows it on the server.
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: qk.podcastEpisodesOfShow('c1', 5, 'Daily News'),
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledWith(target, {}, { fetched: true });
    expect(useEpisodeFetch.getState().pending).toBeNull();
    // Nothing more is asked.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockClient!.podcastFetchStatus).toHaveBeenCalledTimes(2);
    expect(mockClient!.retryPodcastFetch).not.toHaveBeenCalled();
  });

  it("waits the server's longer Retry-After", async () => {
    mockClient!.prepareEpisodeStream.mockRejectedValue(pending503(undefined, 5));
    requestEpisodeFetch(target, book);
    await flush();
    await jest.advanceTimersByTimeAsync(4999);
    expect(mockClient!.podcastFetchStatus).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockClient!.podcastFetchStatus).toHaveBeenCalledTimes(1);
  });

  it('stops at a failure with its code, and never asks again by itself', async () => {
    mockClient!.prepareEpisodeStream.mockRejectedValue(
      new PodcastFetchPendingError('failed', 'podcast_fetch_failed', wire2b.failed, 2),
    );
    requestEpisodeFetch(target, book);
    await flush();
    expect(phase()).toBe('failed');
    expect(useEpisodeFetch.getState().pending?.code).toBe('too_large');
    await jest.advanceTimersByTimeAsync(30_000);
    expect(mockClient!.podcastFetchStatus).not.toHaveBeenCalled();
    expect(mockClient!.retryPodcastFetch).not.toHaveBeenCalled();
  });

  it('asks again with one POST on Try again, then follows it', async () => {
    mockClient!.prepareEpisodeStream.mockRejectedValue(
      new PodcastFetchPendingError('failed', 'podcast_fetch_failed', wire2b.failed, 2),
    );
    requestEpisodeFetch(target, book);
    await flush();
    retryEpisodeFetch();
    await flush();
    expect(mockClient!.retryPodcastFetch).toHaveBeenCalledTimes(1);
    expect(mockClient!.retryPodcastFetch).toHaveBeenCalledWith(5, target.path, expect.anything());
    expect(phase()).toBe('waiting');
    await jest.advanceTimersByTimeAsync(2000);
    expect(mockClient!.podcastFetchStatus).toHaveBeenCalledTimes(1);
    expect(mockClient!.retryPodcastFetch).toHaveBeenCalledTimes(1);
  });

  it('is unavailable with no loop when the server cannot fetch now', async () => {
    const unavailable = fetchStatus({
      state: 'unavailable',
      retry_after_seconds: 0,
      error: { code: 'bridge_unavailable', message: 'x' },
    });
    mockClient!.prepareEpisodeStream.mockRejectedValue(
      new PodcastFetchPendingError('x', 'podcast_fetch_unavailable', unavailable, 2),
    );
    requestEpisodeFetch(target, book);
    await flush();
    expect(phase()).toBe('unavailable');
    expect(useEpisodeFetch.getState().pending?.code).toBe('bridge_unavailable');
    await jest.advanceTimersByTimeAsync(30_000);
    expect(mockClient!.podcastFetchStatus).not.toHaveBeenCalled();
  });

  it('reads absent after a fetch was asked for as a failure without a code', async () => {
    mockClient!.podcastFetchStatus.mockResolvedValue({ fetch: fetchStatus({ state: 'absent' }) });
    requestEpisodeFetch(target, book);
    await flush();
    await jest.advanceTimersByTimeAsync(2000);
    expect(phase()).toBe('failed');
    expect(useEpisodeFetch.getState().pending?.code).toBeNull();
  });

  it('pauses in the background and asks at once on the way back', async () => {
    requestEpisodeFetch(target, book);
    await flush();
    emitAppState('background');
    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockClient!.podcastFetchStatus).not.toHaveBeenCalled();
    emitAppState('active');
    await flush();
    expect(mockClient!.podcastFetchStatus).toHaveBeenCalledTimes(1);
  });

  it('a request for another episode ends the one before (its reads aborted)', async () => {
    requestEpisodeFetch(target, book);
    await flush();
    const firstSignal = mockClient!.prepareEpisodeStream.mock.calls[0][2] as AbortSignal;
    const other = { ...target, path: 'Daily News/Tuesday.mp3' };
    requestEpisodeFetch(other, episodeBook({ rel_path: other.path, title: 'Tuesday' }));
    expect(firstSignal.aborted).toBe(true);
    expect(useEpisodeFetch.getState().pending?.key).toBe(`c1:5:${other.path}`);
    await flush();
    await jest.advanceTimersByTimeAsync(2000);
    // One poll, the new one's.
    expect(mockClient!.podcastFetchStatus.mock.calls).toEqual([[5, other.path, expect.anything()]]);
  });

  it('joins a second tap on the same episode', async () => {
    requestEpisodeFetch(target, book);
    requestEpisodeFetch(target, book);
    await flush();
    expect(mockClient!.prepareEpisodeStream).toHaveBeenCalledTimes(1);
  });

  it('starts where the last tap on it asked, once it is ready', async () => {
    requestEpisodeFetch(target, book);
    await flush();
    requestEpisodeFetch(target, book, { position: 600 });
    expect(mockClient!.prepareEpisodeStream).toHaveBeenCalledTimes(1);
    mockClient!.podcastFetchStatus.mockResolvedValue({ fetch: wire2b.ready });
    await jest.advanceTimersByTimeAsync(2000);
    expect(mockStart.mock.calls).toEqual([[target, { position: 600 }, { fetched: true }]]);
  });

  it('keeps waiting through a proxy 502 or the rate limiter while it follows the fetch', async () => {
    mockClient!.podcastFetchStatus
      .mockRejectedValueOnce(new ApiError(502, 'Bad Gateway'))
      .mockRejectedValueOnce(new ApiError(429, 'Too many requests'));
    requestEpisodeFetch(target, book);
    await flush();
    await jest.advanceTimersByTimeAsync(2000);
    expect(phase()).toBe('waiting');
    // The second blip in a row waits twice as long.
    await jest.advanceTimersByTimeAsync(2000);
    expect(phase()).toBe('waiting');
    await jest.advanceTimersByTimeAsync(2000);
    expect(mockClient!.podcastFetchStatus).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2000);
    expect(mockClient!.podcastFetchStatus).toHaveBeenCalledTimes(3);
  });

  it('backs off while the server keeps failing, and polls every 2 s again once it answers', async () => {
    mockClient!.podcastFetchStatus.mockRejectedValue(new ApiError(500, 'Internal Server Error'));
    requestEpisodeFetch(target, book);
    await flush();
    const calls = () => mockClient!.podcastFetchStatus.mock.calls.length;
    // Looks at 2 s, then 2, 4, 8, 16, 32 and 60 s apart (never more).
    const at: number[] = [];
    for (let s = 1; s <= 200; s++) {
      const before = calls();
      await jest.advanceTimersByTimeAsync(1000);
      if (calls() > before) at.push(s);
    }
    expect(at).toEqual([2, 4, 8, 16, 32, 64, 124, 184]);
    expect(phase()).toBe('waiting');
    mockClient!.podcastFetchStatus.mockResolvedValue({ fetch: wire2b.status_response.fetch });
    await jest.advanceTimersByTimeAsync(60_000);
    const answered = calls();
    await jest.advanceTimersByTimeAsync(2000);
    expect(calls()).toBe(answered + 1);
  });

  it('waits at least the Retry-After of a refused look', () => {
    expect(blipDelay(1)).toBe(2);
    expect(blipDelay(3)).toBe(8);
    expect(blipDelay(10)).toBe(60);
    expect(blipDelay(1, 30)).toBe(30);
  });

  it('is starting only while its start may still play', async () => {
    let started: () => void = () => {};
    mockStart.mockImplementation(() => new Promise((r) => (started = () => r(true))));
    mockClient!.prepareEpisodeStream.mockResolvedValue(undefined);
    requestEpisodeFetch(target, book);
    await flush();
    const key = `c1:5:${target.path}`;
    expect(isEpisodeFetchStarting(key)).toBe(true);
    // A Cancel while it starts: its start finds it gone and plays nothing.
    cancelEpisodeFetch();
    expect(isEpisodeFetchStarting(key)).toBe(false);
    started();
    await flush();
    expect(useEpisodeFetch.getState().pending).toBeNull();
  });

  it('knows the start asked for last, and a start of the episode itself ends its fetch', async () => {
    const key = `c1:5:${target.path}`;
    requestEpisodeFetch(target, book);
    expect(isLatestStart(key)).toBe(true);
    cancelEpisodeFetchUnless(key);
    expect(useEpisodeFetch.getState().pending?.key).toBe(key);
    cancelEpisodeFetchUnless('c1:2:Weir/Artemis');
    expect(isLatestStart(key)).toBe(false);
    expect(useEpisodeFetch.getState().pending).toBeNull();
    requestEpisodeFetch(target, book);
    cancelEpisodeFetchOf('c1:2:Weir/Artemis');
    expect(useEpisodeFetch.getState().pending?.key).toBe(key);
    cancelEpisodeFetchOf(key);
    expect(useEpisodeFetch.getState().pending).toBeNull();
  });

  it('ends on a profile switch', async () => {
    try {
      requestEpisodeFetch(target, book);
      await flush();
      useProfiles.setState({
        hydrated: true,
        profiles: [
          { id: 'sam', name: 'Sam', connectionIds: ['c9'] },
          { id: 'alex', name: 'Alex', connectionIds: ['c1'] },
        ],
        activeProfileId: 'sam',
      });
      expect(useEpisodeFetch.getState().pending).toBeNull();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(mockClient!.podcastFetchStatus).not.toHaveBeenCalled();
    } finally {
      resetProfilesForTests();
    }
  });

  it('ends when its connection is removed', async () => {
    requestEpisodeFetch(target, book);
    await flush();
    mockClient = null;
    useSession.setState({});
    expect(useEpisodeFetch.getState().pending).toBeNull();
  });

  it('is refused when too many are on their way', async () => {
    mockClient!.prepareEpisodeStream.mockRejectedValue(
      new ApiError(409, 'Too many episodes are being fetched.', 'fetch_limit'),
    );
    requestEpisodeFetch(target, book);
    await flush();
    expect(phase()).toBe('refused');
    expect(useEpisodeFetch.getState().pending?.code).toBe('fetch_limit');
  });

  it('reads the episode again when its identity changed, and fails', async () => {
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    mockClient!.retryPodcastFetch.mockRejectedValue(
      new ApiError(409, 'changed', 'identity_changed'),
    );
    requestEpisodeFetch(target, book, {}, { retry: true });
    await flush();
    expect(phase()).toBe('failed');
    expect(useEpisodeFetch.getState().pending?.code).toBe('identity_changed');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.item('c1', 5, target.path) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['podcastEpisodes', 'c1', 5] });
  });

  it.each(['module_off', 'bridge_unavailable', 'library_not_writable'])(
    'reads a %s refusal as unavailable',
    async (code) => {
      mockClient!.retryPodcastFetch.mockRejectedValue(new ApiError(409, 'x', code));
      requestEpisodeFetch(target, book, {}, { retry: true });
      await flush();
      expect(phase()).toBe('unavailable');
      expect(useEpisodeFetch.getState().pending?.code).toBe(code);
    },
  );

  it('keeps waiting through a network blip while it follows the fetch', async () => {
    mockClient!.podcastFetchStatus.mockRejectedValueOnce(new TypeError('Network request failed'));
    requestEpisodeFetch(target, book);
    await flush();
    await jest.advanceTimersByTimeAsync(2000);
    expect(phase()).toBe('waiting');
    await jest.advanceTimersByTimeAsync(2000);
    expect(mockClient!.podcastFetchStatus).toHaveBeenCalledTimes(2);
  });

  it('fails, ready to try again, when the start itself does not happen', async () => {
    mockClient!.prepareEpisodeStream.mockResolvedValue(undefined);
    mockStart.mockResolvedValue(false);
    requestEpisodeFetch(target, book);
    await flush();
    expect(phase()).toBe('failed');
  });

  it('cancels on request, leaving nothing pending', async () => {
    requestEpisodeFetch(target, book);
    await flush();
    cancelEpisodeFetch();
    expect(useEpisodeFetch.getState().pending).toBeNull();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockClient!.podcastFetchStatus).not.toHaveBeenCalled();
  });
});
