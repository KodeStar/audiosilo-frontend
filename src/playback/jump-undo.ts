import { AppState } from 'react-native';
import { create } from 'zustand';

import { ticker } from '@/lib/ticker';

import { selectBookKey, selectBookPosition, usePlayer } from './store';

/**
 * Undo jump (STYLEGUIDE section 8, "Undo jump chip"): after ANY jump of more than a
 * minute of book position, remember where the listener was for 10 seconds so the
 * "Back to 17:26:50" chip can take them back.
 *
 * "Any jump" includes the ones that never pass through our UI - a lock-screen or
 * headphone seek, a CarPlay scrub - so jumps are NOT recorded by the seek actions. They
 * are detected from the player's snapshot stream: consecutive whole-book positions are
 * compared with how far playback could have carried the listener in the wall-clock time
 * between them (`isJump`). That one rule covers every source, and decision 7 holds: the
 * player store is not touched.
 *
 * What must NOT read as a jump, and why it doesn't:
 * - Natural playback, and seeks of a minute or less: within the allowance.
 * - Loading a book or resuming it (0, then the resume point), and a book change: the
 *   baseline is dropped when the book's identity (`selectBookKey`) changes; the snapshot
 *   that was current at that moment belongs to the OLD engine state and is skipped; the
 *   first fresh settled sample becomes the baseline, and the next `SETTLE_MS` only move
 *   it (an engine can report its start position in more than one step).
 * - Retry / reload and buffering: only SETTLED states (`playing`, `paused`) are sampled.
 *   While the engine is `loading`, `ready`, `error`... the last settled sample is kept,
 *   and a reload resumes where it was.
 * - The downloads hot-swap (`switchCurrentBookToLocal`): same book, same position.
 * - The app coming back after iOS suspended JS: while the previous sample was playing,
 *   anything up to (elapsed wall time x rate) is natural, so an hour of background
 *   listening is an hour of allowance. If JS was not running at all (the heartbeat below
 *   stalled), forward movement up to that allowance is accepted even from a paused sample
 *   (a lock-screen play while suspended). Backward movement is never natural. JS can only
 *   be suspended away from the foreground, so the heartbeat runs only while the app is
 *   not active and a book is loaded; in the foreground nothing wakes up once a second, and
 *   a stalled heartbeat is noticed as the app comes back.
 * - The undo itself: `undoJump` marks its landing, which is then not recorded.
 *
 * Known limits, on purpose: a seek in the first `SETTLE_MS` after a book starts makes no
 * chip; a jump that happens while JS is suspended and lands within the playback
 * allowance can't be told from listening; re-loading the SAME book at a far position
 * (a chapter tapped on its book page) is a jump and makes a chip, which is right for a
 * chapter tap.
 *
 * Framework-free: a store plus a subscription, started once from the root layout like
 * `startAutoSleep` (`startJumpUndo`). The chip is `src/components/player/undo-chip.tsx`.
 */

/** Jumps strictly larger than this (seconds of book position) are undoable. */
export const JUMP_THRESHOLD_S = 60;
/** How long the chip lives. */
export const UNDO_WINDOW_MS = 10_000;
/** After a book loads, samples only move the baseline for this long. */
export const SETTLE_MS = 3_000;
/** Two jumps this close are one gesture (a multi-file seek can land in two steps): the
 * chip keeps the first one's "from". */
export const COALESCE_MS = 1_500;
/** The heartbeat's period while a book is loaded and the app is not in the foreground. */
const HEARTBEAT_MS = 1_000;
/** A heartbeat gap longer than this means JS was not running (suspended). */
export const SUSPENSION_GAP_MS = 5_000;
/** How close a landing must be to the undo target to be the undo's own seek. */
const UNDO_LANDING_TOLERANCE_S = 5;
/** How long an undo's landing is waited for. */
const UNDO_LANDING_WINDOW_MS = 5_000;

/** One settled observation of the player. */
export type JumpSample = {
  /** Whole-book position, seconds. */
  position: number;
  /** Whether audio was playing (the only state in which the position advances). */
  playing: boolean;
};

/**
 * Did the position move further than playback could have carried it? Pure.
 *
 * `elapsedSeconds` is the wall-clock time between the samples and `rate` the playback
 * speed (the larger of the two samples' speeds). While `prev` was playing, the natural
 * advance is anywhere from 0 (paused in between, buffering) to elapsed x rate; while it
 * was paused, nothing - unless `unobserved` (JS was suspended, so it may have been played
 * from the lock screen meanwhile). A move beyond that by more than the threshold, or
 * backward by more than it, is a jump.
 */
export function isJump(
  prev: JumpSample,
  next: JumpSample,
  elapsedSeconds: number,
  rate: number,
  unobserved = false,
  threshold = JUMP_THRESHOLD_S,
): boolean {
  const delta = next.position - prev.position;
  if (delta < -threshold) return true;
  const elapsed = Math.max(0, elapsedSeconds);
  const speed = rate > 0 ? rate : 1;
  const allowance = prev.playing || unobserved ? elapsed * speed : 0;
  return delta > allowance + threshold;
}

/** The position to go back to, for one book, until `until`. */
export type JumpUndo = {
  /** Whole-book position before the jump, seconds. */
  from: number;
  /** The book it belongs to (`selectBookKey`). */
  bookKey: string;
  /** Epoch ms when the chip goes away. */
  until: number;
  /** Epoch ms of the jump (coalescing). */
  at: number;
};

/** The current undo, or null. Read it with `useJumpUndo`; act with `undoJump`. */
export const useJumpUndo = create<{ jump: JumpUndo | null }>(() => ({ jump: null }));

/** The live undo for the book `bookKey`, or null (a selector for `useJumpUndo`). */
export function selectUndoFor(bookKey: string | null) {
  return (s: { jump: JumpUndo | null }): JumpUndo | null =>
    s.jump && bookKey !== null && s.jump.bookKey === bookKey ? s.jump : null;
}

let expiry: ReturnType<typeof setTimeout> | null = null;
/** Where `undoJump` is taking the listener, so its own seek isn't recorded as a jump. */
let undoLanding: { bookKey: string; position: number; until: number } | null = null;

/** Forget the undo (and its pending expiry). */
export function clearJumpUndo(): void {
  if (expiry) clearTimeout(expiry);
  expiry = null;
  useJumpUndo.setState({ jump: null });
}

function setJump(jump: JumpUndo): void {
  if (expiry) clearTimeout(expiry);
  useJumpUndo.setState({ jump });
  expiry = setTimeout(
    () => {
      expiry = null;
      if (useJumpUndo.getState().jump === jump) useJumpUndo.setState({ jump: null });
    },
    Math.max(0, jump.until - Date.now()),
  );
}

/** Record a detected jump from `from` to `to` in `bookKey` at `now`. */
function recordJump(bookKey: string, from: number, to: number, now: number): void {
  if (
    undoLanding &&
    undoLanding.bookKey === bookKey &&
    now <= undoLanding.until &&
    Math.abs(to - undoLanding.position) <= UNDO_LANDING_TOLERANCE_S
  ) {
    undoLanding = null; // the undo's own seek
    return;
  }
  const current = useJumpUndo.getState().jump;
  const origin =
    current && current.bookKey === bookKey && now - current.at < COALESCE_MS ? current.from : from;
  // Landed back where the chip would take you: nothing to undo.
  if (Math.abs(to - origin) <= JUMP_THRESHOLD_S) return clearJumpUndo();
  setJump({ from: origin, bookKey, until: now + UNDO_WINDOW_MS, at: now });
}

/**
 * Take the listener back to where they were before the jump (the playing book's live
 * undo only), without creating a new undo. Returns the position it went back to, or null
 * when there was nothing to undo. The caller says so (the chip toasts "Back where you
 * were").
 */
export function undoJump(): number | null {
  const player = usePlayer.getState();
  const jump = selectUndoFor(selectBookKey(player))(useJumpUndo.getState());
  if (!jump || Date.now() > jump.until) return null;
  undoLanding = {
    bookKey: jump.bookKey,
    position: jump.from,
    until: Date.now() + UNDO_LANDING_WINDOW_MS,
  };
  clearJumpUndo();
  void player.seekBook(jump.from);
  return jump.from;
}

/**
 * Watch the player for jumps for the life of the app. Returns a teardown. Started once
 * from `src/app/_layout.tsx`.
 */
export function startJumpUndo(): () => void {
  let bookKey: string | null = null;
  /** The last settled sample, with when it was taken. */
  let baseline: (JumpSample & { at: number; rate: number }) | null = null;
  /** The snapshot current when the book changed: the old engine state, never sampled. */
  let staleSnapshot: unknown = null;
  /** The last snapshot handled (non-snapshot store writes are ignored). */
  let lastSnapshot: unknown = null;
  /** True from a book change until its first settled sample. */
  let settling = false;
  let settleUntil = 0;
  /** When JS last ran, by the heartbeat or a sample (or the foreground, where it always
   * runs). */
  let lastAlive = Date.now();
  /** JS stalled away from the foreground since the last sample (noticed on return). */
  let suspended = false;
  const heartbeat = ticker(() => {
    lastAlive = Date.now();
  }, HEARTBEAT_MS);
  const foreground = () => AppState.currentState === 'active';
  /** A suspension shows as a gap in the heartbeat. */
  const stalled = (now: number) => now - lastAlive > SUSPENSION_GAP_MS;
  const appState = AppState.addEventListener('change', (state) => {
    const now = Date.now();
    if (state === 'active') {
      heartbeat.stop();
      if (bookKey && stalled(now)) suspended = true;
    } else if (bookKey) heartbeat.start();
    lastAlive = now;
  });

  const onState = (s: ReturnType<typeof usePlayer.getState>) => {
    const key = selectBookKey(s);
    if (key !== bookKey) {
      bookKey = key;
      baseline = null;
      staleSnapshot = s.snapshot;
      settling = true;
      undoLanding = null;
      if (useJumpUndo.getState().jump) clearJumpUndo();
      suspended = false;
      lastAlive = Date.now();
      if (key && !foreground()) heartbeat.start();
      else heartbeat.stop();
    }
    if (!key || !s.nowPlaying || s.snapshot === lastSnapshot) return;
    lastSnapshot = s.snapshot;
    if (s.snapshot === staleSnapshot) return;
    staleSnapshot = null;
    if (s.nowPlaying.queue.total <= 0) {
      baseline = null; // no whole-book timeline: positions are per file
      return;
    }
    const { state } = s.snapshot;
    if (state !== 'playing' && state !== 'paused') return; // keep the last settled sample

    const now = Date.now();
    const unobserved = suspended || (!foreground() && stalled(now));
    suspended = false;
    lastAlive = now;
    const sample = {
      position: selectBookPosition(s),
      playing: state === 'playing',
      rate: s.rate,
      at: now,
    };
    if (settling) {
      settling = false;
      settleUntil = now + SETTLE_MS;
    }
    const prev = baseline;
    baseline = sample;
    if (!prev || now < settleUntil) return;
    if (
      isJump(prev, sample, (now - prev.at) / 1000, Math.max(prev.rate, sample.rate), unobserved)
    ) {
      recordJump(key, prev.position, sample.position, now);
    }
  };

  const unsubscribe = usePlayer.subscribe(onState);
  onState(usePlayer.getState());
  return () => {
    unsubscribe();
    appState?.remove();
    heartbeat.stop();
  };
}
