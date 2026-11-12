import { AppState, type NativeEventSubscription } from 'react-native';

import { ApiError, PodcastFetchPendingError } from '@/api/client';
import { resolveClient } from '@/api/connection-clients';
import type { PodcastFetchStatus } from '@/api/types';
import { blipDelay, pollDelay } from '@/playback/episode-fetch-rules';

/**
 * Waiting for a podcast episode to be on its server before it downloads (fe#166, D2). An
 * episode that is not on its server yet answers 503 until the server has fetched it, and the
 * downloads store's queue runs one book at a time: one episode waiting there would hold up
 * every download behind it. So an absent episode waits here, outside the queue, and goes on
 * the queue once its server has it.
 *
 * Each wait asks the stream once (`prepareEpisodeStream`, which starts the server's fetch;
 * `retry` POSTs instead, the listener's Retry after a failed fetch), then follows the fetch's
 * status every max(2, Retry-After) s. Only in the foreground (a poll due in the background
 * runs on the way back), and at most `MAX_WAITING` at once: more wait their turn here, so a
 * listener's own plays keep room under the server's limit of five fetches on their way. A
 * refusal for the moment (the limit, the rate limiter, a blip) waits and asks again; a fetch
 * that failed or can't be made ends the wait with the server's code. Framework-free: the
 * store hands each wait its hooks and stops it (`stopWaiting`) on a cancel or remove.
 */

/** How many episodes ask their server at once. */
export const MAX_WAITING = 3;

/** An episode the downloads store waits for: its registry key and where it lives. */
export type EpisodeWaitRef = { key: string; connectionId: string; libraryId: number; path: string };

/** How a wait ended: on the server (`ready`), a fetch that failed or can't be made now
 * (`failed`; `code` is the server's safe code, null when it said none), or the connection
 * gone (`removed`). */
export type EpisodeWaitEnd =
  { kind: 'ready' } | { kind: 'failed'; code: string | null } | { kind: 'removed' };

export type EpisodeWaitHooks = {
  /** The server's fetch moved (queued, fetching and how far). */
  onStatus: (status: PodcastFetchStatus) => void;
  /** The wait is over (called once, never after `stopWaiting`). */
  onEnd: (end: EpisodeWaitEnd) => void;
};

type Waiter = {
  ref: EpisodeWaitRef;
  hooks: EpisodeWaitHooks;
  /** What the next step asks: the stream once, the listener's POST, or the status. */
  action: 'probe' | 'retry' | 'poll';
  /** Holds one of the `MAX_WAITING` turns. */
  active: boolean;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  /** Answers in a row that said "not now" (a blip, the limiter, the fetch limit). */
  blips: number;
  /** A step was due while the app was in the background: it runs on the way back. */
  paused: boolean;
};

/** The waits, in the order they were asked for (a Map keeps insertion order). */
const waiters = new Map<string, Waiter>();
let appWatch: NativeEventSubscription | null = null;

/**
 * Wait for `ref`'s episode to be on its server; `hooks.onEnd` says how it went. `retry` POSTs
 * a fetch first (the listener's Retry) where a plain wait asks the stream. A wait already
 * there for the key is replaced (the store starts one only for an entry with none).
 */
export function waitForEpisode(
  ref: EpisodeWaitRef,
  hooks: EpisodeWaitHooks,
  { retry = false }: { retry?: boolean } = {},
): void {
  const had = waiters.get(ref.key);
  if (had) drop(had);
  waiters.set(ref.key, {
    ref,
    hooks,
    action: retry ? 'retry' : 'probe',
    active: false,
    abort: new AbortController(),
    timer: null,
    blips: 0,
    paused: false,
  });
  watchApp();
  pump();
}

/** Stop waiting for `key` (a cancel, a remove, a removed connection): no more requests, and
 * no hook is called. The server keeps fetching: nothing is cancelled there. */
export function stopWaiting(key: string): void {
  const w = waiters.get(key);
  if (!w) return;
  drop(w);
  pump();
}

/** Whether `key` is waiting (asking its server, or for its turn to). */
export function isWaiting(key: string): boolean {
  return waiters.has(key);
}

/** How many waits are asking their server now (at most `MAX_WAITING`). */
export function askingCount(): number {
  let n = 0;
  for (const w of waiters.values()) if (w.active) n++;
  return n;
}

function drop(w: Waiter) {
  w.abort.abort();
  if (w.timer) clearTimeout(w.timer);
  w.timer = null;
  if (waiters.get(w.ref.key) === w) waiters.delete(w.ref.key);
  if (waiters.size === 0) {
    appWatch?.remove();
    appWatch = null;
  }
}

/** Give free turns to the waits next in line. */
function pump() {
  let asking = askingCount();
  for (const w of waiters.values()) {
    if (asking >= MAX_WAITING) return;
    if (w.active) continue;
    w.active = true;
    asking++;
    void step(w);
  }
}

/** Polls run only in the foreground: leaving holds the due ones, coming back runs them. */
function watchApp() {
  if (appWatch) return;
  appWatch = AppState.addEventListener('change', (state) => {
    for (const w of waiters.values()) {
      if (!w.active) continue;
      if (state === 'active') {
        if (!w.paused) continue;
        w.paused = false;
        void step(w);
      } else if (state === 'background' && w.timer) {
        clearTimeout(w.timer);
        w.timer = null;
        w.paused = true;
      }
    }
  });
}

const live = (w: Waiter) => waiters.get(w.ref.key) === w;

function end(w: Waiter, how: EpisodeWaitEnd) {
  if (!live(w)) return;
  drop(w);
  w.hooks.onEnd(how);
  pump();
}

/** Ask again in `seconds` (`pollDelay`), or on the way back to the foreground. */
function schedule(w: Waiter, seconds: number) {
  if (!live(w)) return;
  const wait = pollDelay(seconds);
  if (AppState.currentState === 'background') {
    w.paused = true;
    return;
  }
  w.timer = setTimeout(() => {
    w.timer = null;
    void step(w);
  }, wait * 1000);
}

/** Not now (a blip, the limiter, the fetch limit): the same ask again later, waiting longer
 * each time in a row. */
function askAgain(w: Waiter, retryAfter?: number) {
  w.blips++;
  schedule(w, blipDelay(w.blips, retryAfter));
}

async function step(w: Waiter) {
  if (!live(w)) return;
  if (AppState.currentState === 'background') {
    w.paused = true;
    return;
  }
  const { connectionId, libraryId, path } = w.ref;
  const client = resolveClient(connectionId);
  if (!client) return end(w, { kind: 'removed' });
  const signal = w.abort.signal;
  try {
    if (w.action === 'probe') {
      await client.prepareEpisodeStream(libraryId, path, signal);
      return end(w, { kind: 'ready' });
    }
    const answer =
      w.action === 'retry'
        ? await client.retryPodcastFetch(libraryId, path, signal)
        : await client.podcastFetchStatus(libraryId, path, signal);
    if (!live(w)) return;
    settle(w, answer.fetch);
  } catch (e) {
    if (!live(w)) return;
    if (e instanceof PodcastFetchPendingError) return settle(w, e.fetch, e.retryAfterSeconds);
    if (!(e instanceof ApiError)) return askAgain(w);
    if (e.code === 'fetch_limit' || e.status === 429 || e.status >= 500) {
      return askAgain(w, e.retryAfterSeconds);
    }
    end(w, { kind: 'failed', code: e.code ?? null });
  }
}

function settle(w: Waiter, status: PodcastFetchStatus, retryAfter?: number) {
  const code = status.error?.code ?? null;
  switch (status.state) {
    case 'ready':
      return end(w, { kind: 'ready' });
    case 'queued':
    case 'fetching':
      w.blips = 0;
      w.hooks.onStatus(status);
      // On its way: its status from here on (a POST once is enough).
      w.action = 'poll';
      return schedule(w, retryAfter ?? status.retry_after_seconds);
    default:
      // Five on their way already: this one waits its turn and asks again.
      if (status.state === 'unavailable' && code === 'fetch_limit') return askAgain(w, retryAfter);
      // `failed`, `unavailable`, and `absent` after a fetch was asked for (nothing on its way).
      return end(w, { kind: 'failed', code });
  }
}
