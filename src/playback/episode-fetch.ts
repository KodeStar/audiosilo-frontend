import { AppState } from 'react-native';
import { create } from 'zustand';

import { ApiError, PodcastFetchPendingError } from '@/api/client';
import { resolveClient } from '@/api/connection-clients';
import { chaptersQuery, fetchFailFast, itemQuery, qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import type { Book, PodcastFetchStatus, PodcastShow } from '@/api/types';
import type { PlayTarget } from '@/components/player/play-route';
import { startBookInPlace, type StartOptions } from '@/components/player/start-book';
import { contentKeyOf } from '@/lib/content-key';
import { onForeground } from '@/lib/when-active';
import { mayActFor, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

/**
 * Playing an episode that is not on the server yet (Bridge Phase 2d-1). The server fetches
 * it on demand: the first `/stream` read answers 503 with the fetch's status, and the
 * episode plays once it is `ready`. This controller is the one place that waits for that:
 * the starts (`startBookInPlace`, the player route) hand it an episode that needs a fetch,
 * it asks the stream once, follows the status until the episode is ready, then starts it
 * in place (`fetched: true`, so it is not handed back here). Framework-free (a zustand
 * store and functions), so the player's internals never see a fetch: they get a start, at
 * the end, like any other.
 *
 * Never POSTs on its own: only a listener's Try again asks the server to fetch again
 * (it skips the server's cool-down after a failure). There is no time cap: the server ends
 * a fetch that goes nowhere as `failed`.
 */

/** Where a fetch is. `probing`: the stream is being asked; `waiting`: queued or on its way
 * (`status` says how far); `failed` / `unavailable` / `refused` (too many on their way):
 * stopped, with the server's `code`; `starting`: ready, the episode is starting. */
export type EpisodeFetchPhase =
  'probing' | 'waiting' | 'failed' | 'unavailable' | 'refused' | 'starting';

export type PendingEpisodeFetch = {
  /** `contentKeyOf(target)`. */
  key: string;
  target: PlayTarget;
  /** The episode's title. */
  title: string;
  /** The show's title (its folder when the show list is not cached). */
  show: string;
  opts: StartOptions;
  phase: EpisodeFetchPhase;
  status: PodcastFetchStatus | null;
  /** Why it stopped: the server's safe code (`fetchReasonKey`), null when it said none. */
  code: string | null;
};

export const useEpisodeFetch = create<{ pending: PendingEpisodeFetch | null }>(() => ({
  pending: null,
}));

/** Whether `book` is an episode whose file is not on its server (yet). */
export function isAbsentEpisode(book: Book): boolean {
  return !!book.episode && !book.episode.downloaded;
}

/** Whether starting `book` must go through a fetch first: an episode not on its server,
 * on a server that fetches on demand (`podcast_fetch`). Otherwise it plays (or fails) as
 * it always did. */
export function needsEpisodeFetch(book: Book, podcastFetch: boolean | undefined): boolean {
  return isAbsentEpisode(book) && podcastFetch === true;
}

/** The poll interval floor, seconds (the server's `Retry-After`). */
const MIN_POLL_S = 2;

type Run = {
  abort: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  /** In the background with a poll due: it runs on the way back (`AppState`). */
  paused: boolean;
  stop: () => void;
};

/** The one run in flight (`pending`'s). */
let run: Run | null = null;

/** Whether two statuses would show the same (a poll that moved nothing). */
function sameStatus(a: PodcastFetchStatus | null, b: PodcastFetchStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.state === b.state &&
    a.bytes_received === b.bytes_received &&
    a.bytes_total === b.bytes_total &&
    a.error?.code === b.error?.code
  );
}

function patch(r: Run, next: Partial<PendingEpisodeFetch>) {
  if (run !== r) return;
  const pending = useEpisodeFetch.getState().pending;
  if (!pending) return;
  const unchanged =
    (next.phase === undefined || next.phase === pending.phase) &&
    (next.code === undefined || next.code === pending.code) &&
    (next.status === undefined || sameStatus(next.status, pending.status));
  // A poll that moved nothing leaves the store as it is (no re-render of its readers).
  if (!unchanged) useEpisodeFetch.setState({ pending: { ...pending, ...next } });
}

function end(r: Run) {
  r.abort.abort();
  if (r.timer) clearTimeout(r.timer);
  r.timer = null;
  r.stop();
}

/** Stop the fetch in flight, if any (the listener's Cancel; another start). The server
 * keeps fetching: nothing is cancelled there. */
export function cancelEpisodeFetch() {
  if (run) end(run);
  run = null;
  if (useEpisodeFetch.getState().pending) useEpisodeFetch.setState({ pending: null });
}

/** Stop the fetch in flight unless it is for `key` (a start of something else). */
export function cancelEpisodeFetchUnless(key: string) {
  const pending = useEpisodeFetch.getState().pending;
  if (pending && pending.key !== key) cancelEpisodeFetch();
}

/** The show's title from the cached show list, else its folder. */
function showTitleOf(target: PlayTarget, book: Book): string {
  const showPath = book.episode?.show_path ?? '';
  const shows = queryClient.getQueryData<PodcastShow[]>(
    qk.podcastShows(target.connectionId, target.libraryId),
  );
  return shows?.find((s) => s.path === showPath)?.title || book.author || showPath;
}

/**
 * Wait for `book` (an episode, `needsEpisodeFetch`) to be on its server, then start it in
 * place. The same episode asked for again while it is on its way joins it (a second tap);
 * another one replaces it. `retry` asks the server to fetch again (Try again), else the
 * stream is asked once, which starts a fetch when none is on its way.
 */
export function requestEpisodeFetch(
  target: PlayTarget,
  book: Book,
  opts: StartOptions = {},
  { retry = false }: { retry?: boolean } = {},
) {
  const key = contentKeyOf(target);
  const pending = useEpisodeFetch.getState().pending;
  if (!retry && pending?.key === key && run && !isStopped(pending.phase)) return;
  begin(
    {
      key,
      target,
      title: book.title,
      show: showTitleOf(target, book),
      opts,
      status: book.episode?.fetch ?? null,
    },
    retry,
  );
}

/** Try the stopped fetch again (POST: the listener's Try again). */
export function retryEpisodeFetch() {
  const pending = useEpisodeFetch.getState().pending;
  if (!pending) return;
  begin(pending, true);
}

/** Whether a fetch stopped and only Try again moves it on. */
export function isStopped(phase: EpisodeFetchPhase): boolean {
  return phase === 'failed' || phase === 'unavailable' || phase === 'refused';
}

function begin(
  from: Pick<PendingEpisodeFetch, 'key' | 'target' | 'title' | 'show' | 'opts' | 'status'>,
  retry: boolean,
) {
  cancelEpisodeFetch();
  const cid = from.target.connectionId;
  const r: Run = { abort: new AbortController(), timer: null, paused: false, stop: () => {} };
  run = r;
  useEpisodeFetch.setState({
    pending: { ...from, phase: 'probing', code: null },
  });

  // A profile switch or a removed connection ends it (the episode is no longer this
  // listener's to start); coming back to the app asks at once.
  const gone = () => !mayActFor(cid) || !resolveClient(cid);
  const onChange = () => {
    if (run === r && gone()) cancelEpisodeFetch();
  };
  const unProfiles = useProfiles.subscribe(onChange);
  const unSession = useSession.subscribe(onChange);
  const unAppState = onForeground(
    () => {
      if (run !== r || !r.paused) return;
      r.paused = false;
      void step(r, 'poll');
    },
    () => {
      if (run !== r || !r.timer) return;
      clearTimeout(r.timer);
      r.timer = null;
      r.paused = true;
    },
  );
  r.stop = () => {
    unProfiles();
    unSession();
    unAppState();
  };
  void step(r, retry ? 'retry' : 'probe');
}

function pendingOf(r: Run): PendingEpisodeFetch | null {
  return run === r ? useEpisodeFetch.getState().pending : null;
}

async function step(r: Run, action: 'probe' | 'retry' | 'poll') {
  const pending = pendingOf(r);
  if (!pending) return;
  const { connectionId: cid, libraryId, path } = pending.target;
  const client = mayActFor(cid) ? resolveClient(cid) : null;
  if (!client) {
    cancelEpisodeFetch();
    return;
  }
  const signal = r.abort.signal;
  try {
    if (action === 'probe') {
      await client.prepareEpisodeStream(libraryId, path, signal);
      if (run === r) void start(r, client);
      return;
    }
    const answer =
      action === 'retry'
        ? await client.retryPodcastFetch(libraryId, path, signal)
        : await client.podcastFetchStatus(libraryId, path, signal);
    if (run === r) settle(r, client, answer.fetch);
  } catch (e) {
    if (run !== r) return;
    if (e instanceof PodcastFetchPendingError) {
      settle(r, client, e.fetch, e.retryAfterSeconds);
      return;
    }
    // A blip while waiting (offline a moment, a timeout): ask again at the next turn.
    if (action === 'poll' && !(e instanceof ApiError)) {
      schedule(r, MIN_POLL_S);
      return;
    }
    refused(r, e);
  }
}

/** Seed the status the episode page and rows read (`usePodcastFetchStatus`). */
function seed(target: PlayTarget, status: PodcastFetchStatus) {
  queryClient.setQueryData(
    qk.podcastFetch(target.connectionId, target.libraryId, target.path),
    status,
  );
}

function settle(
  r: Run,
  client: NonNullable<ReturnType<typeof resolveClient>>,
  status: PodcastFetchStatus,
  retryAfter?: number,
) {
  const pending = pendingOf(r);
  if (!pending) return;
  seed(pending.target, status);
  switch (status.state) {
    case 'ready':
      void start(r, client);
      return;
    case 'queued':
    case 'fetching':
      patch(r, { phase: 'waiting', status, code: null });
      schedule(r, retryAfter ?? status.retry_after_seconds);
      return;
    case 'unavailable':
      patch(r, { phase: 'unavailable', status, code: status.error?.code ?? null });
      return;
    default:
      // `failed`, and `absent` after a fetch was asked for (nothing on its way): stop.
      patch(r, { phase: 'failed', status, code: status.error?.code ?? null });
  }
}

function schedule(r: Run, seconds: number) {
  if (run !== r) return;
  const wait = Math.max(MIN_POLL_S, Number.isFinite(seconds) ? seconds : 0);
  if (AppState.currentState === 'background') {
    r.paused = true;
    return;
  }
  r.timer = setTimeout(() => {
    r.timer = null;
    void step(r, 'poll');
  }, wait * 1000);
}

/** A refusal of the probe or of Try again, by the server's code. */
function refused(r: Run, e: unknown) {
  const pending = pendingOf(r);
  if (!pending) return;
  const code = e instanceof ApiError ? (e.code ?? null) : null;
  switch (code) {
    case 'fetch_limit':
      patch(r, { phase: 'refused', code });
      return;
    case 'module_off':
    case 'bridge_unavailable':
    case 'library_not_writable':
    case 'demo_account':
      patch(r, { phase: 'unavailable', code });
      return;
    case 'identity_changed': {
      // The feed gave the episode another identity: what the cache holds of it is stale.
      const { connectionId: cid, libraryId, path } = pending.target;
      void queryClient.invalidateQueries({ queryKey: qk.item(cid, libraryId, path) });
      void queryClient.invalidateQueries({ queryKey: qk.podcastEpisodesOfLibrary(cid, libraryId) });
      patch(r, { phase: 'failed', code });
      return;
    }
    default:
      patch(r, { phase: 'failed', code: null });
  }
}

/** Ready: read the item and chapters again (the file's own), mark the show's episode
 * lists stale, then start it in place. */
async function start(r: Run, client: NonNullable<ReturnType<typeof resolveClient>>) {
  const pending = pendingOf(r);
  if (!pending) return;
  patch(r, { phase: 'starting' });
  const { target, opts } = pending;
  const { connectionId: cid, libraryId, path } = target;
  await Promise.all([
    fetchFailFast({ ...itemQuery(cid, client, libraryId, path), staleTime: 0 }),
    fetchFailFast({ ...chaptersQuery(cid, client, libraryId, path), staleTime: 0 }),
  ]).catch(() => {
    // The start below reads them again (or plays from what is cached).
  });
  if (run !== r) return;
  const book = queryClient.getQueryData<Book>(qk.item(cid, libraryId, path));
  const show = book?.episode?.show_path;
  if (show !== undefined) {
    void queryClient.invalidateQueries({
      queryKey: qk.podcastEpisodesOfShow(cid, libraryId, show),
      refetchType: 'none',
    });
  }
  const started = await startBookInPlace(target, opts, { fetched: true }).catch(() => false);
  if (run !== r) return;
  if (started) {
    cancelEpisodeFetch();
  } else {
    patch(r, { phase: 'failed', code: null });
  }
}
