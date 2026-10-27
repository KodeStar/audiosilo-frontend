import { useEffect, useState } from 'react';

import { retryAfterHeader } from '@/api/client';

/**
 * When a directory result's artwork tries again after it failed to load (Bridge Phase
 * 2d-2, fe#126). The server fetches uncached images only a few at a time, so a full
 * results list gets 429 / 503 for some. An image element can't see the status, so a
 * failed load is followed by one HEAD probe of the same URL (the route takes no extra
 * parameter), and the answer picks the wait:
 * - busy (429 / 503) with a `Retry-After`: wait that long, and every other row of the
 *   server waits until then too without probing (`notBefore`), so a burst of failures is
 *   one probe, not one per row. Busy waits don't use up the tries, up to
 *   `ARTWORK_BUSY_MAX_WAITS`;
 * - gone (an expired id: 404, or any 400 / 403 / 410): keep the placeholder;
 * - anything else (no answer, no readable header, a 200 the image then fails on):
 *   3 s, 10 s and 30 s (four tries in all), then the placeholder.
 */
export const ARTWORK_RETRY_DELAYS_MS = [3_000, 10_000, 30_000] as const;

/** Busy waits a row sits out before it stops trying. */
export const ARTWORK_BUSY_MAX_WAITS = 6;

/** The longest wait a `Retry-After` can ask for here (a row on screen is not left blank
 * for minutes). */
const MAX_BUSY_WAIT_MS = 60_000;

/** A probe that gets no answer within this is no answer. */
const PROBE_TIMEOUT_MS = 15_000;

const GONE = new Set([400, 403, 404, 410]);
const BUSY = new Set([429, 503]);

/** The wait before the next try after `failures` failed tries, or null: stop trying. */
export function artworkRetryDelay(failures: number): number | null {
  return failures >= 1 ? (ARTWORK_RETRY_DELAYS_MS[failures - 1] ?? null) : null;
}

/** What a probe of an artwork URL answered. */
export type ArtworkProbe = { status: number; retryAfterSeconds?: number };

/** HEAD the artwork URL for its status and `Retry-After`; null when nothing answers. */
export async function probeArtwork(uri: string): Promise<ArtworkProbe | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(uri, { method: 'HEAD', signal: abort.signal });
    return { status: res.status, retryAfterSeconds: retryAfterHeader(res) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Until when (epoch ms) a server's artwork is busy, by connection id. */
const notBefore = new Map<string, number>();

/** A server's probe on its way, by connection id: a row failing meanwhile waits for its
 * answer before probing, so a burst of failures sends one probe while the server is busy. */
const probing = new Map<string, Promise<unknown>>();

/** Forget every server's busy window (tests). */
export function resetArtworkBusy(): void {
  notBefore.clear();
  probing.clear();
}

/** How long a busy answer (429 / 503 with a `Retry-After`) asks to wait, bounded; null
 * for any other answer. */
function busyAnswerMs(answer: ArtworkProbe | null): number | null {
  if (!answer || !BUSY.has(answer.status) || answer.retryAfterSeconds === undefined) return null;
  return Math.min(Math.max(answer.retryAfterSeconds * 1_000, 1_000), MAX_BUSY_WAIT_MS);
}

/** A busy wait when the server's busy window is open, else null. */
function busyWait(key: string): ArtworkNextTry | null {
  const until = notBefore.get(key) ?? 0;
  if (until <= Date.now()) return null;
  // Spread the rows that waited together, so they don't all ask again at once.
  return { delay: until - Date.now() + Math.round(Math.random() * 1_000), busy: true };
}

/** The next try: how long to wait and whether it is a busy wait; null: stop trying. */
export type ArtworkNextTry = { delay: number; busy: boolean };

/**
 * The next try of an artwork that failed to load, after `quiet` failures that were not
 * busy answers and `busy` busy waits (see the module comment).
 */
export async function nextArtworkTry(
  key: string,
  uri: string,
  quiet: number,
  busy: number,
  probe: (uri: string) => Promise<ArtworkProbe | null> = probeArtwork,
): Promise<ArtworkNextTry | null> {
  const canWait = busy < ARTWORK_BUSY_MAX_WAITS;
  const waiting = probing.get(key);
  if (canWait && waiting) await waiting.catch(() => undefined);
  const wait = canWait ? busyWait(key) : null;
  if (wait) return wait;
  // The busy window opens before the rows waiting on this probe read it.
  const asking = probe(uri).then((answer) => {
    const ms = busyAnswerMs(answer);
    if (ms !== null) notBefore.set(key, Date.now() + ms);
    return answer;
  });
  probing.set(key, asking);
  const answer = await asking.finally(() => {
    if (probing.get(key) === asking) probing.delete(key);
  });
  if (answer && GONE.has(answer.status)) return null;
  const ms = busyAnswerMs(answer);
  if (canWait && ms !== null) return { delay: ms, busy: true };
  const delay = artworkRetryDelay(quiet + 1);
  return delay === null ? null : { delay, busy: false };
}

type RetryState = {
  uri: string | null;
  /** Loads started: the image's key, so the same URL mounted again is a new request. */
  tries: number;
  quiet: number;
  busy: number;
  /** The latest try failed (the placeholder shows until the next one mounts). */
  failed: boolean;
};

const fresh = (uri: string | null): RetryState => ({
  uri,
  tries: 0,
  quiet: 0,
  busy: 0,
  failed: false,
});

/**
 * One artwork's tries (`nextArtworkTry`'s schedule). `key` names the server (its busy
 * window is shared); another `uri` starts over.
 */
export function useArtworkRetry(key: string, uri: string | null) {
  const [state, setState] = useState(() => fresh(uri));
  let current = state;
  if (state.uri !== uri) {
    current = fresh(uri);
    setState(current);
  }
  const { failed, tries, quiet, busy } = current;
  useEffect(() => {
    if (!failed || !uri) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void nextArtworkTry(key, uri, quiet, busy).then((next) => {
      if (cancelled || !next) return;
      timer = setTimeout(
        () =>
          setState((s) =>
            s.uri === uri && s.tries === tries
              ? {
                  ...s,
                  failed: false,
                  quiet: s.quiet + (next.busy ? 0 : 1),
                  busy: s.busy + (next.busy ? 1 : 0),
                }
              : s,
          ),
        next.delay,
      );
    });
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [key, uri, failed, tries, quiet, busy]);
  const onError = () => setState((s) => ({ ...s, tries: s.tries + 1, failed: true }));
  return { failed, tries, onError };
}
