// Pure decision logic for the end-credits (book-finished) screen's auto-play countdown.
// Framework-free so it can be unit-tested directly; the screen wires it to the player
// store, the settings store and a 1s ticker. Two countdown regimes:
//
//   - The finished book is STILL PLAYING (an early arrival - the credits audio is still
//     running). The countdown shows the remaining audio time, but auto-play never fires
//     from here: it waits for the book to actually end (do not start the next book early).
//   - The book is ALREADY OVER (arrived via a natural end, or it ended while this screen
//     was up). A fixed grace countdown runs, then auto-play fires.
//
// A Cancel (`cancelled`) stops auto-play for this visit: the countdown is hidden and the
// Play-next button stays. Auto-play is only ever considered when it is enabled and a next
// book exists.

/** Seconds of grace before auto-play fires once the book is over. */
export const GRACE_SECONDS = 15;

export type EndCreditsInput = {
  /** The `autoPlayNext` setting. */
  autoPlayNext: boolean;
  /** Whether a next book in the series was resolved. */
  hasNext: boolean;
  /** The finished book's audio is still running (arrived before its natural end). */
  stillPlaying: boolean;
  /** Live remaining audio time (whole-book total minus current position), when playing. */
  remainingSeconds: number;
  /** The user cancelled auto-play for this visit. */
  cancelled: boolean;
  /** Seconds elapsed on the grace countdown (only meaningful once the book is over). */
  elapsedGrace: number;
};

export type EndCreditsDecision = {
  /** Show the "Starting in X" countdown + Cancel affordance. */
  showCountdown: boolean;
  /** Seconds remaining until auto-play fires, for the countdown label. */
  countdownSeconds: number;
  /** Auto-play should fire now. */
  fireNext: boolean;
};

const IDLE: EndCreditsDecision = { showCountdown: false, countdownSeconds: 0, fireNext: false };

export function endCreditsDecision(input: EndCreditsInput): EndCreditsDecision {
  const { autoPlayNext, hasNext, stillPlaying, remainingSeconds, cancelled, elapsedGrace } = input;
  // No auto-play at all: nothing to count down, nothing to fire.
  if (!autoPlayNext || !hasNext || cancelled) return IDLE;

  if (stillPlaying) {
    // Count down the remaining audio; the actual start waits for the real end (the
    // ended transition flips `stillPlaying` false and hands over to the grace regime).
    return {
      showCountdown: true,
      countdownSeconds: Math.max(0, remainingSeconds),
      fireNext: false,
    };
  }

  // Book is over: fixed grace, then fire.
  const remaining = Math.max(0, GRACE_SECONDS - elapsedGrace);
  return { showCountdown: true, countdownSeconds: remaining, fireNext: remaining <= 0 };
}
