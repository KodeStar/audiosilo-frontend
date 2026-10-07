import { isJump } from './jump-undo';
import { selectBookKey, selectBookPosition, selectIsTransportLive, usePlayer } from './store';

/**
 * The listener's LAST deliberate touch of the player, per book: when it was (wall clock)
 * and where the book was. It answers "when did they last show they were awake?", which is
 * what the "You drifted off around 23:41" prompt is built from (`drift-controller.ts`):
 * everything played between that moment and the sleep timer stopping the book was most
 * likely heard by nobody.
 *
 * Framework-free and memory-only (one entry per book key, the newest few kept): it only
 * has to survive from a touch to the timer firing later that night, and the sleep timer
 * copies what it needs at the moment it fires.
 *
 * ## What counts
 *
 * Two sources, and both are cheap:
 *
 * - **What the store shows** (`startInteractionWatch`): the transport starting or stopping
 *   (play, pause, a lock-screen or headphone button), and the position JUMPING (a seek, a
 *   skip, a chapter change) rather than flowing. That covers every surface, including the
 *   ones that never pass through our UI (the lock screen, CarPlay), with no change to the
 *   player store. The store's own noise is harmless here: a buffering stall stays "live"
 *   in the loose reading used, and a misread edge only makes the listener look awake
 *   somewhat later than they were - which shortens the prompt's "jump back", never
 *   invents one.
 * - **Explicit notes** (`noteInteraction`): touches the store cannot see, i.e. arming or
 *   re-arming a sleep timer (the sheet, a shake, "Keep listening"). The player UI can call
 *   it for anything else deliberate.
 *
 * The automatic sleep timer arming on a play edge is NOT a touch (the play edge is).
 */

/** Where and when the listener last touched the player for one book. */
export type Interaction = {
  /** Epoch ms. */
  at: number;
  /** Whole-book position, seconds. */
  position: number;
};

/** More than a night's books; the oldest go first. */
const MAX_BOOKS = 20;

/** A position change this much bigger (content seconds) than playback could have made
 * since the last move is a jump, not playback (`isJump`, the Undo chip's rule, with this
 * finer threshold). Under the smallest skip the UI offers (5 s), well over a progress
 * tick's drift. */
const JUMP_SECONDS = 4;

const last = new Map<string, Interaction>();

function remember(bookKey: string, entry: Interaction) {
  last.delete(bookKey); // re-insert at the end: Map order is the eviction order
  last.set(bookKey, entry);
  if (last.size > MAX_BOOKS) {
    const oldest = last.keys().next().value;
    if (oldest !== undefined) last.delete(oldest);
  }
}

/** Record a deliberate touch of the book loaded now, at its current position. A no-op
 * with nothing loaded. */
export function noteInteraction(): void {
  const player = usePlayer.getState();
  const key = selectBookKey(player);
  if (key === null) return;
  remember(key, { at: Date.now(), position: selectBookPosition(player) });
}

/** The last touch recorded for a book (`contentKey`), or null when there is none. */
export function lastInteraction(bookKey: string): Interaction | null {
  return last.get(bookKey) ?? null;
}

/** Forget everything (tests). */
export function resetInteractions(): void {
  last.clear();
}

/**
 * Watch the player store for the touches it can show: the transport going live or
 * stopping, and the position jumping. Returns the unsubscribe. Started once, by the
 * drift controller.
 */
export function startInteractionWatch(): () => void {
  let prevLive = selectIsTransportLive(usePlayer.getState());
  let prevKey = selectBookKey(usePlayer.getState());
  let prevPosition = selectBookPosition(usePlayer.getState());
  let prevTrack = usePlayer.getState().snapshot.trackIndex;
  let prevAt = Date.now();
  return usePlayer.subscribe((state) => {
    const key = selectBookKey(state);
    const live = selectIsTransportLive(state);
    const track = state.snapshot.trackIndex;
    let position = selectBookPosition(state);
    const now = Date.now();
    const rate = Math.max(1, state.rate);
    // A multi-file book playing on into its next file is playback, not a touch. The
    // native engine reports the new file before its position (the track change, then a
    // progress tick about a second later), so for that moment the position reads about a
    // file further on: when the new file's start is where playback would be, take that.
    if (key === prevKey && live && prevLive && track === prevTrack + 1) {
      const fileStart = state.nowPlaying?.queue.offsets?.[track];
      if (
        fileStart !== undefined &&
        !isJump(
          { position: prevPosition, playing: true },
          { position: fileStart, playing: true },
          (now - prevAt) / 1000,
          rate,
          false,
          JUMP_SECONDS,
        )
      )
        position = fileStart;
    }
    // Nothing this watches moved (a write of something else): nothing to read, and the
    // flow allowance keeps counting from the last move.
    if (key === prevKey && live === prevLive && position === prevPosition && track === prevTrack)
      return;
    if (key !== null) {
      if (key !== prevKey) {
        // A book was started: that is a touch in itself.
        if (live) remember(key, { at: now, position });
      } else if (live !== prevLive) {
        remember(key, { at: now, position });
      } else if (
        // Playback moves the position by at most the elapsed time times the speed (never
        // less than 1x here), and only while it is live; anything beyond that, either
        // way, was moved.
        isJump(
          { position: prevPosition, playing: prevLive },
          { position, playing: live },
          (now - prevAt) / 1000,
          rate,
          false,
          JUMP_SECONDS,
        )
      ) {
        remember(key, { at: now, position });
      }
    }
    prevKey = key;
    prevLive = live;
    prevPosition = position;
    prevTrack = track;
    prevAt = now;
  });
}
