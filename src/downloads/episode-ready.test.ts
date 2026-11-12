import { AppState } from 'react-native';

let mockClients: Record<string, Record<string, jest.Mock> | null>;
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (cid: string) => mockClients[cid] ?? null,
}));

/* eslint-disable import/first */
import { ApiError, PodcastFetchPendingError } from '@/api/client';
import type { PodcastFetchStatus } from '@/api/types';
import { fetchStatus, wire2b } from '@/testing/podcast-fixtures';

import {
  askingCount,
  type EpisodeWaitEnd,
  isWaiting,
  MAX_WAITING,
  stopWaiting,
  waitForEpisode,
} from './episode-ready';
/* eslint-enable import/first */

const pending503 = (status: PodcastFetchStatus = wire2b.stream_response.fetch, wait = 2) =>
  new PodcastFetchPendingError('Episode is being fetched.', 'podcast_fetching', status, wait);

let appState: string;
let appListeners: ((s: string) => void)[];
const emitAppState = (s: string) => {
  appState = s;
  [...appListeners].forEach((l) => l(s));
};

/** Let the waits' awaits run (no time passes). */
const flush = () => jest.advanceTimersByTimeAsync(0);

let client: Record<string, jest.Mock>;
let ends: Record<string, EpisodeWaitEnd>;
let statuses: Record<string, PodcastFetchStatus[]>;
const started: string[] = [];

/** Wait for episode `n` (path `ep-<n>`) on connection c1. */
function wait(n: number, retry = false) {
  const key = `c1:5:ep-${n}`;
  started.push(key);
  waitForEpisode(
    { key, connectionId: 'c1', libraryId: 5, path: `ep-${n}` },
    {
      onStatus: (s) => (statuses[key] ??= []).push(s),
      onEnd: (e) => (ends[key] = e),
    },
    { retry },
  );
  return key;
}

beforeEach(() => {
  jest.useFakeTimers();
  client = {
    prepareEpisodeStream: jest.fn().mockRejectedValue(pending503()),
    podcastFetchStatus: jest.fn().mockResolvedValue({ fetch: fetchStatus({ state: 'fetching' }) }),
    retryPodcastFetch: jest.fn().mockResolvedValue({ fetch: fetchStatus({ state: 'queued' }) }),
  };
  mockClients = { c1: client };
  ends = {};
  statuses = {};
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
  for (const key of started.splice(0)) stopWaiting(key);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('waitForEpisode', () => {
  it('asks the stream once, follows the status, and ends ready', async () => {
    client.podcastFetchStatus
      .mockResolvedValueOnce({ fetch: fetchStatus({ state: 'fetching', retry_after_seconds: 3 }) })
      .mockResolvedValueOnce({ fetch: wire2b.ready });
    const key = wait(1);
    await flush();
    expect(client.prepareEpisodeStream).toHaveBeenCalledTimes(1);
    expect(client.prepareEpisodeStream.mock.calls[0].slice(0, 2)).toEqual([5, 'ep-1']);
    expect(statuses[key]).toHaveLength(1);
    // Retry-After (2 s, the 503's) first, then the status's own 3 s.
    await jest.advanceTimersByTimeAsync(1999);
    expect(client.podcastFetchStatus).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(client.podcastFetchStatus).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3000);
    expect(client.podcastFetchStatus).toHaveBeenCalledTimes(2);
    expect(ends[key]).toEqual({ kind: 'ready' });
    expect(isWaiting(key)).toBe(false);
    // Nothing is asked once it ended.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(client.podcastFetchStatus).toHaveBeenCalledTimes(2);
  });

  it('ends ready at once for an episode its server has (the probe streams)', async () => {
    client.prepareEpisodeStream.mockResolvedValue(undefined);
    const key = wait(1);
    await flush();
    expect(ends[key]).toEqual({ kind: 'ready' });
    expect(client.podcastFetchStatus).not.toHaveBeenCalled();
  });

  it("ends failed with the server's code, and Retry POSTs", async () => {
    client.prepareEpisodeStream.mockRejectedValue(
      pending503(fetchStatus({ state: 'failed', error: { code: 'too_large', message: 'x' } })),
    );
    const key = wait(1);
    await flush();
    expect(ends[key]).toEqual({ kind: 'failed', code: 'too_large' });

    client.retryPodcastFetch.mockResolvedValue({ fetch: fetchStatus({ state: 'queued' }) });
    client.podcastFetchStatus.mockResolvedValue({ fetch: wire2b.ready });
    delete ends[key];
    wait(1, true);
    await flush();
    expect(client.retryPodcastFetch).toHaveBeenCalledTimes(1);
    expect(client.prepareEpisodeStream).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2000);
    expect(ends[key]).toEqual({ kind: 'ready' });
  });

  it('ends unavailable on a refusal only a person can lift', async () => {
    client.prepareEpisodeStream.mockRejectedValue(
      new ApiError(409, 'no bridge', 'bridge_unavailable'),
    );
    const key = wait(1);
    await flush();
    expect(ends[key]).toEqual({ kind: 'unavailable', code: 'bridge_unavailable' });
  });

  it('waits and asks again at the fetch limit, and on a blip', async () => {
    client.prepareEpisodeStream
      .mockRejectedValueOnce(new ApiError(409, 'limit', 'fetch_limit'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(undefined);
    const key = wait(1);
    await flush();
    expect(ends[key]).toBeUndefined();
    await jest.advanceTimersByTimeAsync(2000);
    expect(client.prepareEpisodeStream).toHaveBeenCalledTimes(2);
    // Twice in a row: the wait doubles.
    await jest.advanceTimersByTimeAsync(3999);
    expect(client.prepareEpisodeStream).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(ends[key]).toEqual({ kind: 'ready' });
  });

  it('ends removed when the connection is gone', async () => {
    mockClients = {};
    const key = wait(1);
    await flush();
    expect(ends[key]).toEqual({ kind: 'removed' });
  });

  it('stops polling once stopped (a cancel), and calls no hook', async () => {
    const key = wait(1);
    await flush();
    stopWaiting(key);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(client.podcastFetchStatus).not.toHaveBeenCalled();
    expect(ends[key]).toBeUndefined();
    expect(isWaiting(key)).toBe(false);
  });

  it(`asks for no more than ${MAX_WAITING} at once; the next goes when one ends`, async () => {
    const keys = [1, 2, 3, 4].map((n) => wait(n));
    await flush();
    expect(askingCount()).toBe(MAX_WAITING);
    expect(client.prepareEpisodeStream).toHaveBeenCalledTimes(3);
    expect(client.prepareEpisodeStream.mock.calls.map((c) => c[1])).toEqual([
      'ep-1',
      'ep-2',
      'ep-3',
    ]);
    expect(isWaiting(keys[3])).toBe(true);
    stopWaiting(keys[0]);
    await flush();
    expect(client.prepareEpisodeStream).toHaveBeenCalledTimes(4);
    expect(client.prepareEpisodeStream.mock.calls[3][1]).toBe('ep-4');
  });

  it('joins a wait already on its way instead of asking again', async () => {
    wait(1);
    wait(1);
    await flush();
    expect(client.prepareEpisodeStream).toHaveBeenCalledTimes(1);
  });

  it('pauses in the background and asks at once on the way back', async () => {
    const key = wait(1);
    await flush();
    emitAppState('background');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(client.podcastFetchStatus).not.toHaveBeenCalled();
    emitAppState('active');
    await flush();
    expect(client.podcastFetchStatus).toHaveBeenCalledTimes(1);
    expect(isWaiting(key)).toBe(true);
  });

  it('does not start asking while the app is in the background', async () => {
    appState = 'background';
    wait(1);
    await flush();
    expect(client.prepareEpisodeStream).not.toHaveBeenCalled();
    emitAppState('active');
    await flush();
    expect(client.prepareEpisodeStream).toHaveBeenCalledTimes(1);
  });
});
