import { create } from 'zustand';

import type { Chapter } from '@/api/types';

import { nextChapterEnd } from './book-queue';
import { engineTicker } from './engine-ticks';
import { lastInteraction, noteInteraction, type Interaction } from './last-interaction';
import { prettifyChapterTitle } from './prettify-title';
import { wallClockSeconds } from './rate';
import { selectBookKey, selectBookPosition, selectIsTransportLive, usePlayer } from './store';

/**
 * Wall-clock seconds before the timer fires at which it enters its `ending` phase:
 * the window in which a shake (or the grace card's "Keep listening" button) re-arms it,
 * and - for a DURATION timer only - the span over which the gain ramps down.
 *
 * Named for the fade because the fade is what sets its length. An end-of-chapter
 * timer gets the same window but no ramp: its last 30 seconds are the words the
 * listener stayed awake for, and the chapter ending is its own audible signal.
 */
export const FADE_SECONDS = 30;

/**
 * Wall-clock seconds after the timer has paused playback during which a shake still
 * counts: it re-arms the timer AND resumes playback, so a listener who was still
 * awake never has to unlock the phone.
 */
export const GRACE_SECONDS = 30;

/**
 * How often the fade rewrites the engine gain. The countdown tick (1s) is far too
 * coarse for a smooth ramp - at 1s steps the last few seconds sound like discrete
 * volume drops - so the fade gets its own faster ticker that only runs while a
 * duration timer is ramping.
 */
const FADE_TICK_MS = 250;

/**
 * A chapter target must be at least this far away (wall clock) to be worth arming.
 * It is the rule that makes "one more chapter" mean the NEXT chapter once a chapter
 * timer is about to stop: a chapter ending that close IS the boundary we are already
 * stopping at, so retargeting it would keep listening for no extra listening.
 *
 * Deliberately its OWN constant rather than an alias of `FADE_SECONDS`: they happen
 * to share a value but are unrelated concepts, and while they were tied together
 * retuning the fade silently changed what "one more chapter" retargets.
 */
const MIN_CHAPTER_SECONDS = 30;

/**
 * Fallback when a chapter timer has nowhere left to go: the listener's reset has run out
 * of book, or an AUTOMATIC arm found no chapter boundary it is allowed to aim at (see
 * `nextChapterTarget`). Doing nothing would silently drop the timer - and for the
 * automatic arm that is the worse failure of the two, because a timer that never fires
 * also never returns the store to `idle`, which blocks every later automatic arm for the
 * rest of the session.
 *
 * One constant for both because it answers one question - "a chapter timer with no
 * chapter to arm" - and erring SHORT is right for both askers: a timer nobody explicitly
 * set should stop the book sooner rather than later, and a listener who is still awake
 * gets it back at its full length with a shake.
 */
const FALLBACK_MINUTES = 15;

/**
 * How long a duration timer may sit frozen (playback paused) before the resume re-arms
 * it at its FULL original length instead of continuing the frozen countdown.
 *
 * Freezing the countdown while paused (see `syncPlaybackFreeze`) is what makes "30
 * minutes" mean 30 minutes of listening, but it introduces the inverse failure: a timer
 * frozen with 3 minutes left, forgotten about, and firing 3 minutes into tomorrow
 * evening's session. Re-arming after a long enough pause gets both behaviours out of one
 * rule, with no setting to explain: a pause is either part of this listening session
 * (make a cup of tea, a phone call - keep the countdown you were on) or it ended it.
 *
 * 20 minutes because it has to clear the longest ordinary in-session interruption while
 * still being far short of "later that day". Audiobookshelf re-arms unconditionally
 * above 3 seconds, which throws away a 25-minute countdown because someone answered the
 * door - too aggressive for a daytime pause. There is deliberately no setting: both
 * behaviours are what the listener would have asked for anyway.
 */
export const RESET_AFTER_PAUSE_SECONDS = 20 * 60;

/**
 * How long a duration timer may sit frozen before the resume ENDS it outright instead of
 * re-arming it.
 *
 * `RESET_AFTER_PAUSE_SECONDS` above answers "is this the same sitting?", but nothing ever
 * cancels a frozen timer, so on its own it answers that question for a pause of ANY
 * length - including one that lasted overnight. A 30-minute timer armed at 22:30 and
 * paused at 22:40 would re-arm itself, at its full length, when the listener picked the
 * same book up at 08:00 the next morning, and fade the book out at 08:30: no user action,
 * hours outside the auto sleep window, and no re-check of why the timer existed.
 *
 * So a freeze this long is not an interruption OR a new sitting of the old one - it is
 * evidence that the timer belongs to a session that is over. It ends as `expired` (the
 * listener never dismissed it), which leaves auto sleep free to arm a fresh one from the
 * play edge if tonight's window actually applies.
 *
 * 2 hours because it has to clear anything that is still plausibly one evening's
 * listening with a long break in it (a meal, an errand, a film) while being far short of
 * "I picked this up the next day". Between 20 minutes and this, the full-length re-arm
 * above is still the right answer; beyond it, no length of timer is.
 */
export const ABANDON_AFTER_PAUSE_SECONDS = 2 * 60 * 60;

/**
 * How long after firing a live transport still does NOT count as the listener resuming
 * by hand: the pause is asynchronous, and the engine keeps reporting `playing` (with a
 * progress tick or two) until it lands. See `syncGrace`.
 */
const PAUSE_SETTLE_MS = 2000;

/**
 * How far (content seconds) the position may sit from where the timer stopped it, during
 * the grace, before that counts as the listener scrubbing. Generous enough for the audio
 * that plays between asking for the pause and it landing (more at 2x).
 */
const SCRUB_SECONDS = 5;

/** How the current timer was armed - what a shake resets it back to. */
export type SleepOrigin = { kind: 'duration'; minutes: number } | { kind: 'chapter' };

/**
 * How `startChapterTimer` should behave when no chapter boundary is worth arming.
 *
 * The difference exists because the two callers mean different things by "end of
 * chapter", and one shared fallback served one of them badly:
 *
 * - the LISTENER's reset (a shake, or "Keep listening") means "one more
 *   chapter"; where there is no next chapter, the end of the book is the honest answer,
 *   so it passes `{ allowEndOfBook: true }`;
 * - the AUTOMATIC nightly arm (`auto-sleep-controller.ts`) means "stop me at the next
 *   natural break", and the end of a book is not one - it can be ten hours away on a
 *   chapterless book, which is a timer that never fires. It passes nothing (or
 *   `{ allowEndOfBook: false }`, which is the same thing said out loud) and degrades to a
 *   short duration timer instead. See `nextChapterTarget`.
 */
export type ChapterTimerOptions = {
  /** May this timer aim at the end of the BOOK when no chapter boundary qualifies?
   * Default false. */
  allowEndOfBook?: boolean;
};

/**
 * Why a timer stopped existing. Recorded by the action that performs the ending, never
 * inferred by a bystander from the fields it left behind: an earlier version of the auto
 * sleep memory read `graceUntil !== null` as "it fired", which quietly filed a
 * cancellation made DURING the grace window as an expiry - the one case where getting it
 * wrong re-arms a timer the listener had just cancelled.
 *
 * - `cancelled` the listener stopped it by hand (whoever armed it). Auto sleep treats
 *   this as final for that book: never silently put the timer back.
 * - `expired`   it ran its course - it fired and its grace window closed, it fired
 *   against a book that was not playing, or its book was replaced under it. The listener
 *   never asked for it to stop, so a later play edge may arm a fresh one.
 */
export type SleepEndReason = 'cancelled' | 'expired';

/**
 * The listener fell asleep: the timer FIRED and paused a playing book, and its grace
 * window then closed with nobody keeping it going - no shake or "Keep listening", no
 * resume, no scrub. Only that path carries one (see `closeGrace`); every other ending,
 * including an `expired` one (fired against a paused book, book replaced, abandoned
 * after a long pause), does not.
 */
export type FellAsleep = {
  /** Whole-book position where the timer paused playback. */
  stoppedAt: number;
  /** The listener's last touch of the player before the timer fired (`last-interaction`),
   * or null when none was recorded for this book. */
  touch: Interaction | null;
};

/** The end of one book's timer: which book, and why it ended. The payload of
 * `onSleepTimerEnded`, which is how anything outside this module hears about it.
 * `fellAsleep` is set only for an `expired` timer the listener slept through. */
export type SleepOutcome = { bookKey: string; reason: SleepEndReason; fellAsleep?: FellAsleep };

/** What the timer remembers about its firing, for the grace that follows it. */
type Fired = FellAsleep & {
  /** Epoch ms of the fire. */
  at: number;
  /** The listener showed they were awake during the grace (resumed by hand, or moved the
   * position): when the window closes it is not a drift-off. Sticky. */
  stirred: boolean;
};

/**
 * The timer's state machine, stored directly (not derived from a set of booleans -
 * three flags could represent twice as many combinations as are legal, and the UI
 * kept spelling the phase out from them by hand).
 *
 * - `idle`    no timer.
 * - `running` counting down at full volume.
 * - `ending`  inside the final `FADE_SECONDS`: about to stop, a shake re-arms. A
 *   duration timer also ramps its gain down here; a chapter timer does not (see
 *   `fadesAudio`), which is why this phase is not called `fading`.
 * - `grace`   playback has been paused; a shake still re-arms AND resumes.
 */
export type SleepPhase = 'idle' | 'running' | 'ending' | 'grace';

/**
 * A label as a translation DESCRIPTOR, not a rendered string. This store is
 * framework-free (see `src/i18n/locale.ts` on why non-React modules must not pull
 * `react-i18next` into their graph), and a string baked in at arm time would also
 * keep the old language for the life of the timer after a language switch. The UI
 * renders it with `t(label.key, label.params)` on every render instead.
 */
export type SleepLabel = {
  key:
    | 'player.sleepTimer.minutes'
    | 'player.sleepTimer.endOf'
    | 'player.sleepTimer.endOfChapterNumber'
    | 'player.sleepTimer.endOfBook'
    | 'player.sleepTimer.afterChapters';
  params?: Record<string, string | number>;
};

/**
 * The two tickers stay SEPARATE on purpose: folding the 1s countdown into the 250ms
 * fade would quadruple the JS wakeups for the whole timer (30 minutes) to save one
 * interval during its last 30 seconds. Both are `engineTicker` (`./engine-ticks`), whose
 * `start()` is idempotent - which is what lets `syncFade` be a reconcile that starts the
 * fade ticker unconditionally, including from inside that ticker's own callback, without
 * anyone having to ask first whether it is already running.
 *
 * `engineTicker` rather than a bare interval because Android pauses JS timers with the
 * screen off: the engine's progress events then run them instead (about once a second,
 * so the fade steps once a second there), and the timer still fades and pauses the book.
 * Both callbacks read the wall clock (`endsAt`, `graceUntil`), so when they run is
 * immaterial to what they compute.
 */

/** The 1s countdown: updates `remaining`, fires, and expires the grace window. */
const countdownTicker = engineTicker(() => useSleepTimer.getState().tick(), 1000);
/** The 250ms fade ramp; runs only while a DURATION timer is in its `ending` phase. */
const fadeTicker = engineTicker(() => syncFade(), FADE_TICK_MS);

/**
 * Watches the player store for the transport starting/stopping, so a duration timer
 * freezes the instant playback pauses rather than up to a tick later.
 *
 * That instant matters more than it looks: iOS suspends the app soon after it stops
 * producing audio and a hidden web tab is throttled, so the 1s tick may simply never run
 * again after the pause - and a pause we never noticed is a pause we cannot subtract.
 * Reacting to the store write happens while the app is still awake handling that very
 * pause, so `frozenAt` is always recorded.
 *
 * It deliberately IGNORES the callback's `(state, prev)` payload and re-reads the level
 * ("is the transport live right now?") instead. The engine's state stream is noisy -
 * a resume arrives as a jumble of `ready`/`loading`/spurious `paused` - so matching
 * individual transitions is the approach that has failed repeatedly in this codebase
 * (see the `subscribe` notes in `store.ts`). Re-reading a boolean cannot desynchronise.
 */
let unwatchPlayback: (() => void) | null = null;
const playbackWatch = {
  start() {
    if (unwatchPlayback) return;
    unwatchPlayback = usePlayer.subscribe(() => {
      syncGrace();
      syncPlaybackFreeze();
      syncChapterHold();
    });
  },
  stop() {
    unwatchPlayback?.();
    unwatchPlayback = null;
  },
};

/** The countdown and the play-state watch always run together: the timer only cares
 * about play/pause while it has something counting down. */
function startCountdown() {
  countdownTicker.start();
  playbackWatch.start();
}

function stopCountdown() {
  countdownTicker.stop();
  playbackWatch.stop();
}

/**
 * Does this timer's ending window ramp the volume down?
 *
 * Only a duration timer. Its stopping point is arbitrary - some sentence 30 minutes
 * in - so a gentle fade beats an abrupt cut. An end-of-chapter timer stops at a
 * boundary the listener CHOSE: those last 30 seconds are the words they stayed awake
 * for, so they play at full volume and the chapter ending is the signal.
 */
function fadesAudio(origin: SleepOrigin | null): boolean {
  return origin?.kind === 'duration';
}

/**
 * The fade curve: gain as a function of the wall-clock seconds left. Perceived
 * loudness is roughly the square root of linear gain, so a LINEAR ramp stays loud
 * for most of the window and then falls off a cliff at the very end. Squaring the
 * normalized time makes the ramp feel even. Exported for its unit test.
 */
export function fadeGain(remaining: number): number {
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  if (remaining >= FADE_SECONDS) return 1;
  const t = remaining / FADE_SECONDS;
  return t * t;
}

/** Push a gain to the engine. `setOutputVolume` clamps, skips a write that would not
 * change the gain the engine is already at, and no-ops before an engine exists, so
 * every caller here can stay ignorant of all three - including the many defensive
 * restores below, which cost nothing when the volume was never touched. */
function writeGain(gain: number) {
  void usePlayer.getState().setOutputVolume(gain);
}

/** Undo the fade. Called from every path that ends or re-arms a timer - a listener
 * left with inaudible audio and no idea why is the worst failure this feature has. */
function restoreVolume() {
  writeGain(1);
}

/**
 * Wall-clock seconds left right now, recomputed from the live clock / book position
 * rather than the 1s `remaining` field (which is far too coarse to ramp against).
 * Null when no timer is armed. The state is passed in so a caller that has already
 * read it doesn't pay for a second `getState()`.
 *
 * A duration timer is a DEADLINE (`endsAt`), never a running total decremented by the
 * tick: read against the real clock, it is immune to ticks that arrive late, early or
 * not at all, so a throttled-but-playing tab can never make the timer run long. While
 * frozen, the clock the deadline is read against stops at `frozenAt` - see
 * `syncPlaybackFreeze` for why the freeze is expressed that way.
 */
function preciseRemaining(state: SleepTimerState): number | null {
  if (state.endsAt !== null) return (state.endsAt - (state.frozenAt ?? Date.now())) / 1000;
  if (state.pauseAtPosition !== null) {
    const player = usePlayer.getState();
    return wallClockSeconds(state.pauseAtPosition - selectBookPosition(player), player.rate);
  }
  return null;
}

/**
 * When the post-pause grace window closes, for a timer that is in the `grace` phase.
 * `fire` writes `graceUntil` together with that phase and only the reset to idle clears
 * them, so a grace without a deadline cannot occur; reading a missing one as "already
 * closed" says that in the type system instead of a non-null assertion, and ends a
 * nonsense state rather than holding it open forever.
 */
function graceDeadline(state: SleepTimerState): number {
  return state.graceUntil ?? 0;
}

/**
 * A timer belongs to the book it was armed for. `pauseAtPosition` is a position on THAT
 * book's timeline and the fade writes the engine gain for whatever is playing, so a
 * timer that outlives its book is actively harmful: it pauses the next book seconds in,
 * plays it near-silent, or (when the book simply ended and `nowPlaying` went null) never
 * reaches an unreachable target and ticks for the rest of the process - which also pins
 * `phase` away from `idle` so auto sleep can never arm again.
 *
 * So every path that can observe the world moving on checks this and ends the timer, which
 * restores the volume and stops both tickers. Both tickers check it, not just the 1s
 * countdown: the fade writes gain on its own 250ms schedule and would otherwise get four
 * chances to quiet the new book before the countdown noticed.
 *
 * It records `expired`, not `cancelled` (see `SleepEndReason`). The listener never asked
 * for this timer to stop - the book it was counting down simply stopped being the one
 * playing - so blocking auto sleep on that book for the rest of the night, because they
 * dipped into another book for five minutes, would be the "resume at 3am with nothing
 * armed" failure all over again. Recording SOMETHING (rather than staying silent) also
 * matters: it clears the book's standing-timer mark, so the memory is never left holding
 * a timer that no longer exists.
 */
function cancelIfBookChanged(state: SleepTimerState): boolean {
  if (state.phase === 'idle' || state.bookKey === selectBookKey(usePlayer.getState())) return false;
  useSleepTimer.getState().endTimer('expired');
  return true;
}

/**
 * The fade reconciler, and the ONLY place the fade ticker or the engine gain is
 * touched. It makes the world match one invariant:
 *
 *     the ramp runs iff  phase === 'ending'  AND the origin fades  AND it is not frozen
 *
 * so every site that writes `phase` or `frozenAt` simply calls this afterwards and has
 * nothing else to remember. That single rule used to be asserted by hand at six sites,
 * where the standing risk was a new one forgetting a piece of it - a ticker left running
 * on a timer that no longer fades, or (much worse) a gain left down on a book nobody is
 * fading any more.
 *
 * Being a reconcile rather than a transition handler, it is safe to call redundantly, in
 * any order, from anywhere - including from the fade ticker's own callback, since
 * `ticker.start` is idempotent.
 *
 * Deliberately does NOT call `set()`: the gain changes four times a second and nothing
 * in the UI displays it, so storing it would re-render every player subscriber at 4Hz
 * for no visible gain. The UI reads only the coarse 1s `remaining` and the `phase`.
 */
function syncFade() {
  const state = useSleepTimer.getState();
  // Not ramping, for any of the three reasons: stop the ticker and hand the volume
  // back. A chapter timer never ramps at all; a frozen one has its ramp suspended at
  // full volume until playback resumes (nothing is playing to fade, and the listener
  // may hit play on the very next breath).
  if (state.phase !== 'ending' || !fadesAudio(state.origin) || state.frozenAt !== null) {
    fadeTicker.stop();
    restoreVolume();
    return;
  }
  if (cancelIfBookChanged(state)) return; // its `endTimer` already ran this reconcile
  const remaining = preciseRemaining(state);
  if (remaining === null) {
    fadeTicker.stop();
    restoreVolume();
    return;
  }
  fadeTicker.start();
  writeGain(fadeGain(remaining));
}

/**
 * Keep the `ending` phase in sync with the countdown, in BOTH directions: enter it
 * when the remaining time drops into the window, and leave it if the remaining time
 * climbs back out - which a backward seek on an end-of-chapter timer does. Without the
 * second half a seek could strand the book at a fraction of its volume for the rest of
 * the chapter.
 *
 * A FROZEN countdown is never in the `ending` phase either, and that is the same rule
 * rather than a second one: `ending` means "about to stop", and a countdown that is not
 * counting is not about to stop. It matters because the phase is public - it is what
 * keeps the accelerometer subscribed (`selectSleepExtendable`) and what shows the grace
 * card ("Fading out in 20 s") - and a book paused with 20 seconds left would otherwise
 * sit in that phase, at full volume, indefinitely: nothing but a thaw ever re-evaluates
 * it. A shake there would silently reset the timer without
 * resuming (the grace, not the ending window, is what resumes).
 *
 * The same holds for an end-of-chapter timer whose book is paused (`countdownHeld`): it
 * has no `frozenAt` (its position target needs no freezing), but a chapter paused 20
 * seconds before its end is no more "about to stop" than a frozen duration timer, and
 * leaving it `ending` kept the accelerometer on and the grace card counting down over a
 * paused book, where a shake retargeted the next chapter without resuming.
 *
 * Otherwise the phase change is unconditional - both kinds of timer become extendable for
 * their last `FADE_SECONDS` - and what that means for the audio is entirely `syncFade`'s
 * business: a chapter timer (or a frozen one) never even starts the fade ticker, and
 * leaving the window restores full volume.
 */
function syncEndingPhase(remaining: number) {
  const state = useSleepTimer.getState();
  const { phase } = state;
  const held = countdownHeld(state);
  if (phase === 'running' && !held && remaining <= FADE_SECONDS) {
    useSleepTimer.setState({ phase: 'ending' });
  } else if (phase === 'ending' && (held || remaining > FADE_SECONDS)) {
    useSleepTimer.setState({ phase: 'running' });
  } else {
    return; // the phase did not move, so the fade cannot have anything to reconcile
  }
  syncFade(); // and start the ramp on THIS tick, not 250ms later
}

/**
 * Is the countdown standing still? A duration timer is frozen by a pause (`frozenAt`, see
 * `syncPlaybackFreeze`). An end-of-chapter timer counts down by book position, which a
 * paused book does not advance, so it is held whenever the transport is not live - read
 * live rather than recorded, because its target stays valid however long the pause and
 * there is nothing to slide on the resume. Only `syncEndingPhase` asks: a held countdown
 * is never `ending`. (Firing does not ask: a chapter target reached while paused is the
 * `fire` path's "nothing was playing" case.)
 */
function countdownHeld(state: SleepTimerState): boolean {
  if (state.frozenAt !== null) return true;
  return state.pauseAtPosition !== null && !selectIsTransportLive(usePlayer.getState());
}

/**
 * The play-state watch's half of `countdownHeld` for an end-of-chapter timer: leave the
 * `ending` phase the instant its book pauses, and re-enter it the instant it resumes
 * still inside the window - on the event, as `syncPlaybackFreeze` does for a duration
 * timer, because after a pause the app may never tick again (iOS suspends it, a hidden
 * tab is throttled). Runs on every player write, so it answers "nothing to do" from the
 * timer's own fields for everything but a chapter timer inside its last `FADE_SECONDS`.
 */
function syncChapterHold() {
  const state = useSleepTimer.getState();
  if (state.pauseAtPosition === null) return;
  const inWindow =
    state.phase === 'ending' ||
    (state.phase === 'running' && state.remaining !== null && state.remaining <= FADE_SECONDS);
  if (!inWindow || cancelIfBookChanged(state)) return;
  syncEndingPhase(preciseRemaining(state) ?? 0);
}

/**
 * Freeze the countdown while playback is not playing, and thaw it when it starts again -
 * so a "30 minute" timer means 30 minutes of LISTENING. Called from the 1s tick, from
 * every arm, and from the play-state watch (`playbackWatch`); it is a reconcile against
 * the live play state, not a transition handler, so calling it redundantly is free and
 * missing a call only delays it to the next tick.
 *
 * ## Why the freeze is a paused CLOCK, not a decremented balance
 *
 * The obvious implementation - subtract 1s per tick while playing - is wrong here,
 * because the ticks are exactly what stops arriving: iOS suspends the app once it is no
 * longer producing audio, and a hidden web tab is throttled to a trickle. A scheme that
 * needs ticks to notice time has passed silently loses an untick'd hour.
 *
 * So a duration timer stays a `Date.now()` DEADLINE, and pausing records `frozenAt`, the
 * moment the clock stopped. `preciseRemaining` then reads the deadline against
 * `frozenAt` instead of the live clock, which is a frozen answer that needs no ticks at
 * all to stay correct - the app can sleep for an hour and wake up with the same number.
 * Resuming slides `endsAt` forward by exactly how long the freeze lasted, which is
 * measured from two timestamps rather than accumulated, so it survives any gap.
 *
 * ## What is NOT frozen
 *
 * - **End-of-chapter timers** (`endsAt === null`). They count down by book position,
 *   which does not advance while paused, so they are already frozen by construction -
 *   and a position target stays valid however long the pause was, so they are also
 *   exempt from the long-pause re-arm below.
 * - **The post-pause grace window** (`endsAt === null` too). It is genuinely wall-clock:
 *   it is the window in which a shake undoes a pause the timer just performed, and it
 *   must expire while the audio is stopped. `keepListening` re-checks that clock.
 */
function syncPlaybackFreeze() {
  const state = useSleepTimer.getState();
  // Cheapest guards first. This runs on EVERY write to the player store (a progress tick
  // several times a second) as well as on every countdown tick, and these two reads
  // answer "nothing to do" on essentially all of them: there is no duration countdown to
  // freeze, or the freeze already matches the transport.
  if (state.endsAt === null || state.origin?.kind !== 'duration') return;
  const live = selectIsTransportLive(usePlayer.getState());
  if (live === (state.frozenAt === null)) return; // already in the right state
  // Only now, on a real freeze/thaw, pay for the book check: a timer whose book has been
  // replaced is over, and must not have its countdown slid (or re-armed) against whatever
  // is playing instead. Nothing above this line mutates, so every mutation is still
  // guarded by it. What the reordering gives up is the watch noticing a book change on a
  // notification where the freeze state did not move - which the 1s tick and `syncFade`
  // both still catch, the fade within 250ms.
  //
  // It is reached by a SINGLE store write that moves both at once, which is the shape of
  // both teardown paths in `store.ts`: `stop()` writes `nowPlaying: null` together with
  // the reset snapshot, and `playBook`'s failed-resume bail writes the new book together
  // with `state: 'error'`. Either would otherwise freeze a dead book's timer here and
  // leave it standing until the next tick.
  if (cancelIfBookChanged(state)) return;
  if (!live) {
    // A pause can land mid-fade. Recording the freeze suspends the ramp and hands the
    // volume straight back (`syncFade`): the listener may hit play on the very next
    // breath, and a book that resumes at a fifth of its volume for no visible reason is
    // the worst failure this feature has. The ramp is not lost - the thaw picks it up at
    // the gain the frozen countdown implies, so it neither restarts nor jumps.
    useSleepTimer.setState({ frozenAt: Date.now() });
    // ...and with the ramp suspended and the volume back, this is no longer a timer that
    // is about to stop, so it leaves the `ending` phase too (see `syncEndingPhase`).
    syncEndingPhase(preciseRemaining(useSleepTimer.getState()) ?? 0);
    syncFade();
    return;
  }
  // Clamped at zero: the span is two readings of a clock the DEVICE owns, and a backward
  // jump (a manual clock change, an NTP correction) would otherwise be a negative span
  // that drags `endsAt` closer and fires the timer early.
  const frozenFor = Math.max(0, Date.now() - (state.frozenAt ?? Date.now()));
  if (frozenFor > ABANDON_AFTER_PAUSE_SECONDS * 1000) {
    // Beyond any interruption or same-day gap: this timer belongs to a session that is
    // over, and resurrecting it would stop a book hours from when anything was asked for.
    // `expired`, not `cancelled` - nobody dismissed it, so tonight may still arm a fresh
    // one on its own terms.
    useSleepTimer.getState().endTimer('expired');
    return;
  }
  if (frozenFor > RESET_AFTER_PAUSE_SECONDS * 1000) {
    // Long enough that this is a new listening session, not an interruption of the old
    // one: give the listener the whole timer they originally asked for.
    useSleepTimer.getState().startDuration(state.origin.minutes);
    return;
  }
  useSleepTimer.setState({ endsAt: state.endsAt + frozenFor, frozenAt: null });
  // Back into the `ending` phase if the thawed countdown still warrants it - the freeze
  // left it, and this is the thaw that re-evaluates it, on this event rather than a tick
  // later.
  syncEndingPhase(preciseRemaining(useSleepTimer.getState()) ?? 0);
  syncFade(); // resume the ramp from where it froze, on this event
}

/**
 * Close the post-pause grace window, the one way a fired timer runs its course. It is
 * `expired` either way; it is a DRIFT-OFF (`fellAsleep`) unless the listener stirred
 * during the window (see `syncGrace`) - which is what the "Fell asleep" bookmark and the
 * "You drifted off" prompt hang off (`drift-controller.ts`).
 */
function closeGrace(state: SleepTimerState) {
  const fired = state.fired;
  useSleepTimer
    .getState()
    .endTimer(
      'expired',
      fired && !fired.stirred ? { stoppedAt: fired.stoppedAt, touch: fired.touch } : undefined,
    );
}

/**
 * The grace window's reconcile, run from the play-state watch (every player write) and
 * the 1s tick. Two jobs:
 *
 * 1. **Close it once its deadline has passed.** The tick alone is not enough: iOS suspends
 *    the app once the timer has paused the audio, so on the night that matters no tick runs
 *    until the app wakes - and the thing that wakes it can be the listener pressing play
 *    the next morning. Seeing that write here (deadline long gone) closes the window as the
 *    drift-off it was, instead of a tick a moment later finding the book playing and
 *    reading it as a listener who resumed by hand.
 * 2. **Notice the listener stirring inside it**: the transport live again once the pause
 *    has settled (`PAUSE_SETTLE_MS` - the engine reports `playing` for a moment after the
 *    pause is asked for), or the position moved away from where the timer stopped it (a
 *    scrub). Either says they were awake, so the window closing is not a drift-off.
 */
function syncGrace() {
  const state = useSleepTimer.getState();
  if (state.phase !== 'grace') return; // the cheap answer for almost every write
  if (cancelIfBookChanged(state)) return;
  const now = Date.now();
  if (now >= graceDeadline(state)) {
    closeGrace(state);
    return;
  }
  const fired = state.fired;
  if (!fired || fired.stirred) return;
  const player = usePlayer.getState();
  const resumed = selectIsTransportLive(player) && now - fired.at >= PAUSE_SETTLE_MS;
  const scrubbed = Math.abs(selectBookPosition(player) - fired.stoppedAt) > SCRUB_SECONDS;
  if (resumed || scrubbed) useSleepTimer.setState({ fired: { ...fired, stirred: true } });
}

/**
 * The "End of <chapter>" label for a chapter, with the numbered fallback for an
 * untitled one. A descriptor, so the untitled case is ONE key with a number rather
 * than a `t()` nested inside another `t()`. Exported so the sheet labels the timer
 * it starts the same way this module labels the one a shake re-arms.
 */
export function chapterSleepLabel(chapter: Chapter): SleepLabel {
  return chapter.title
    ? { key: 'player.sleepTimer.endOf', params: { chapter: prettifyChapterTitle(chapter.title) } }
    : { key: 'player.sleepTimer.endOfChapterNumber', params: { number: chapter.index + 1 } };
}

/**
 * The next end-of-chapter target worth arming, from the LIVE queue: the nearest upcoming
 * chapter end more than `MIN_CHAPTER_SECONDS` away, and - only when the caller allows it -
 * the end of the book. Null when there is nothing left to aim at (the caller then falls
 * back to a duration timer rather than silently doing nothing).
 *
 * The "far enough away" rule is what makes one function serve both callers: for an
 * auto-armed timer at the start of playback the current chapter usually qualifies,
 * while in the `ending` phase it does not (its end IS the boundary we were stopping
 * at), so a shake reset naturally retargets the NEXT chapter - the listener's "one
 * more chapter". In the post-pause grace the position already sits at the old boundary,
 * so the chapter now playing is the next one and qualifies directly.
 *
 * ## Why the end of the book is the caller's decision
 *
 * `allowEndOfBook` is TRUE for the listener's own reset: a shake in the last chapter
 * means "one more chapter", and where there is no next chapter the end of the book is the
 * honest answer to that.
 *
 * It is FALSE for an AUTOMATIC arm, where the same answer is a bug. A folder-of-MP3s book
 * with no chapter metadata has `queue.chapters === []` (`buildBookQueue` only synthesizes
 * virtual chapters for a single-file book), so "end of chapter" at 22:00 armed a target
 * ten hours away: it never fired, so the timer never returned to `idle`, so the auto sleep
 * controller's "a timer already stands" guard blocked every later arm AND stopped its poll
 * - the listener got no working sleep timer at all, all night. That is why a chapter that
 * ends exactly where the BOOK ends is refused here too, not just the explicit fallback: on
 * a single-file book whose only "chapter" is the whole book, that chapter IS the ten-hour
 * target wearing a chapter's name.
 *
 * Where a chapter ends on the whole-book timeline, and how far away that is, are
 * `book-queue.ts`'s business (it owns the whole-book timeline mapping) - so the scan
 * itself is `nextChapterEnd` there, beside the sheet's stop-after rows. Two copies
 * of that formula would let the list the listener picks from and the boundary a shake
 * retargets drift apart.
 */
function nextChapterTarget(allowEndOfBook: boolean): ChapterTimerTarget | null {
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  if (!np) return null;
  return chapterTimerTarget(np.queue, selectBookPosition(player), player.rate, allowEndOfBook);
}

/** Where a chapter timer would stop, and how long until then (wall clock). */
export type ChapterTimerTarget = { position: number; label: SleepLabel; untilEnd: number };

/**
 * `nextChapterTarget` over plain inputs: the boundary `startChapterTimer` arms. Exported
 * so the sleep sheet's "End of chapter" countdown is computed by the very rule the timer
 * it starts uses - a sheet that said "in 12m" for a timer aiming somewhere else would be
 * the drift `nextChapterEnd` exists to prevent.
 */
export function chapterTimerTarget(
  queue: { chapters: Chapter[]; total: number },
  position: number,
  rate: number,
  allowEndOfBook: boolean,
): ChapterTimerTarget | null {
  const total = queue.total;
  const next = nextChapterEnd(queue.chapters, position, rate, MIN_CHAPTER_SECONDS);
  // `total <= 0` is a book whose duration is unknown, where "does this chapter end where
  // the book does?" has no answer - take the chapter, which is a real boundary either way.
  if (next && (allowEndOfBook || total <= 0 || next.endPosition < total)) {
    return {
      position: next.endPosition,
      label: chapterSleepLabel(next.chapter),
      untilEnd: next.untilEnd,
    };
  }
  const untilEnd = wallClockSeconds(total - position, rate);
  if (allowEndOfBook && untilEnd > MIN_CHAPTER_SECONDS) {
    return { position: total, label: { key: 'player.sleepTimer.endOfBook' }, untilEnd };
  }
  return null;
}

export type SleepTimerState = {
  /** Where the timer is in its lifecycle - the single source of truth for the UI. */
  phase: SleepPhase;
  /** What to show for this timer; null when idle. See `SleepLabel`. */
  label: SleepLabel | null;
  /** Epoch ms when a duration timer fires. */
  endsAt: number | null;
  /** Epoch ms at which a duration timer's countdown froze because playback stopped;
   * null while it is running (and always null for an end-of-chapter timer, which needs
   * no freezing). `endsAt` is read against this instead of the live clock while set, and
   * the resume slides `endsAt` forward by the frozen span. See `syncPlaybackFreeze`. */
  frozenAt: number | null;
  /** Whole-book position at which an end-of-chapter timer fires. */
  pauseAtPosition: number | null;
  /** Seconds left, for display: of the countdown while running/ending, of the grace
   * window once the timer has fired. */
  remaining: number | null;
  /** What this timer resets to when the listener shakes the phone. */
  origin: SleepOrigin | null;
  /** The `grace` phase's DEADLINE: epoch ms until which a shake still re-arms AND
   * resumes. Null in every other phase, but nothing branches on that - `phase ===
   * 'grace'` is the question, and this is only ever the answer to "until when?". */
  graceUntil: number | null;
  /** `contentKey` of the book this timer was armed for; null when idle (or when it was
   * armed with nothing loaded). The timer cancels itself once this stops matching the
   * book that is playing - see `cancelIfBookChanged`. */
  bookKey: string | null;
  /** What the fire recorded (where it stopped the book, the listener's last touch before
   * it, whether they have stirred since), for the `grace` phase only; null otherwise. */
  fired: Fired | null;

  /** Arm a timer for `minutes` of wall-clock time. */
  startDuration: (minutes: number) => void;
  /** Pause when the whole-book timeline reaches `position`; `label` describes it to
   * the UI (e.g. "End of Chapter 12") and is supplied by the caller. */
  startUntilPosition: (position: number, label: SleepLabel) => void;
  /**
   * Arm at the next worthwhile end-of-chapter boundary (see `nextChapterTarget`), falling
   * back to a short duration timer (`FALLBACK_MINUTES`) when there is none.
   *
   * `allowEndOfBook` chooses BETWEEN THE TWO FALLBACKS, and the two callers want
   * different ones (see `ChapterTimerOptions`). It defaults to false - the automatic
   * arm's answer - because that is the one that can never arm a timer hours long, and a
   * caller that has not thought about it should get the conservative one.
   */
  startChapterTimer: (opts?: ChapterTimerOptions) => void;
  /**
   * "Keep listening" - the shake (and its tap equivalent) reset. Restores full
   * volume and re-arms the timer at its ORIGINAL setting: a 30-minute timer becomes
   * 30 minutes again, an end-of-chapter timer retargets the next chapter. Inside the
   * post-pause grace it also resumes playback. A no-op outside the ending/grace
   * windows, so a stray shake mid-book can never disturb a running timer.
   *
   * A timer set to stop after SEVERAL chapters ("Or stop after 3 chapters") is a chapter
   * timer too, and re-arms for ONE more chapter, not the same N again. The N was the
   * listener's guess at how long they would last tonight; a shake in its last seconds is
   * "a little more", and handing back another hour of chapters to someone that sleepy
   * would mostly be listened to by nobody. Another shake at the next boundary gives
   * another chapter.
   */
  keepListening: () => void;
  /** The listener stops the timer by hand. Reports a `cancelled` outcome (see
   * `onSleepTimerEnded`), which keeps auto sleep out of this book for the session. */
  cancel: () => void;
  /** Internal 1s tick (countdown + firing + grace expiry). */
  tick: () => void;
  /** Internal: the timer reached its target - pause and open the grace window. */
  fire: () => void;
  /**
   * Internal: drop the timer, back to idle, and tell `onSleepTimerEnded` subscribers
   * WHY. The single ending path - every other one delegates here - so no route out of a
   * live timer can forget to say what happened to it. `fellAsleep` is passed only by
   * `closeGrace`.
   */
  endTimer: (reason: SleepEndReason, fellAsleep?: FellAsleep) => void;
};

/** Every field of an idle timer, so a reset can never leave one behind. */
const IDLE = {
  phase: 'idle',
  label: null,
  endsAt: null,
  frozenAt: null,
  pauseAtPosition: null,
  remaining: null,
  origin: null,
  graceUntil: null,
  bookKey: null,
  fired: null,
} as const;

/** Subscribers to `onSleepTimerEnded`, in registration order. */
const endedListeners = new Set<(outcome: SleepOutcome) => void>();

/**
 * Be told when a timer ENDS, and why - the one event this store emits.
 *
 * ```ts
 * const unsubscribe = onSleepTimerEnded(({ bookKey, reason }) => { ... });
 * ```
 *
 * The registry is the shape this is (mirroring `onConnectionRemoved` in
 * `src/stores/session.ts`), because an ending is an EVENT, not a piece of state: it
 * happens once, it is about the timer that just stopped existing, and no UI displays
 * it. It used to be smuggled through the store as a `lastOutcome` field, which needed
 * three bespoke rules (keep it out of the idle reset, preserve the previous object when
 * there is no book, always replace wholesale) purely so its single consumer could spot a
 * new one by object identity. None of that survives here.
 *
 * The contract:
 * - Called synchronously from `endTimer`, which is the single ending path: a
 *   cancellation, a fired timer's grace window closing, a fire against a book that was
 *   not playing, or the book being replaced under the timer. Exactly one call per
 *   ending.
 * - The store is already back to `idle` when it fires, so a subscriber may read the
 *   store (or arm a new timer) without seeing the dead one.
 * - A timer armed with nothing loaded (`bookKey === null`) notifies NOTHING: there is
 *   no book to attribute the ending to, and its consumers are all per-book.
 * - `reason` is recorded by the action that ended the timer, never inferred - see
 *   `SleepEndReason`, which is the difference between "the listener dismissed this"
 *   and "it ran its course".
 * - Returns an unsubscribe. A listener that throws would take the ending path down
 *   with it, so keep the body trivial.
 */
export function onSleepTimerEnded(fn: (outcome: SleepOutcome) => void): () => void {
  endedListeners.add(fn);
  return () => {
    endedListeners.delete(fn);
  };
}

export const useSleepTimer = create<SleepTimerState>()((set, get) => {
  /** Shared arming path: every start resets the phase, drops any previous fade and
   * restarts the tick. */
  const arm = (
    fields: Pick<SleepTimerState, 'label' | 'endsAt' | 'pauseAtPosition' | 'remaining' | 'origin'>,
  ) => {
    // Scoped to the book that is playing NOW, so this timer can never outlive it.
    set({
      ...fields,
      phase: 'running',
      frozenAt: null,
      graceUntil: null,
      fired: null,
      bookKey: selectBookKey(usePlayer.getState()),
    });
    // The new phase is `running`, so this stops the old timer's ramp and hands the volume
    // back: a previous fade must never leak into the new timer.
    syncFade();
    startCountdown();
    // Armed while the book is paused (from the sheet, or by the shake that re-arms
    // inside the post-pause grace): freeze it here rather than a tick later, so no
    // wall-clock time is spent before the listener has actually resumed.
    syncPlaybackFreeze();
    // A target already inside the final window (a chapter ending in 20s) is armed
    // straight into the `ending` phase, fading from here if it is a duration timer.
    if (fields.remaining !== null) syncEndingPhase(fields.remaining);
  };

  return {
    ...IDLE,

    startDuration: (minutes) => {
      arm({
        label: { key: 'player.sleepTimer.minutes', params: { count: minutes } },
        endsAt: Date.now() + minutes * 60_000,
        pauseAtPosition: null,
        remaining: minutes * 60,
        origin: { kind: 'duration', minutes },
      });
    },

    startUntilPosition: (position, label) => {
      const player = usePlayer.getState();
      if (!player.nowPlaying) return;
      const pos = selectBookPosition(player);
      arm({
        label,
        endsAt: null,
        pauseAtPosition: position,
        // The pause fires by position, but the displayed countdown is wall-clock:
        // content-seconds remaining shrink by the playback rate (2x → half the time).
        remaining: Math.round(wallClockSeconds(position - pos, player.rate)),
        origin: { kind: 'chapter' },
      });
    },

    startChapterTimer: (opts) => {
      const target = nextChapterTarget(opts?.allowEndOfBook ?? false);
      if (target) get().startUntilPosition(target.position, target.label);
      // Nothing left to aim at: a short duration timer beats dropping the request on the
      // floor. For the listener that is more listening time; for an automatic arm it is
      // the difference between a timer and no timer at all (see `FALLBACK_MINUTES`).
      else get().startDuration(FALLBACK_MINUTES);
    },

    keepListening: () => {
      const { origin, phase } = get();
      // Only inside the ending window or the post-pause grace: outside them there is
      // nothing to keep listening to, and a stray shake must not reset a timer that is
      // still fine.
      if (!origin || (phase !== 'ending' && phase !== 'grace')) return;
      // A shake can beat the pending tick, so this path checks the book itself rather
      // than trusting the tick to have cancelled first: re-arming (and resuming) against
      // a book that has ended or been replaced is exactly what must not happen.
      if (cancelIfBookChanged(get())) return;
      // The phase alone is not proof the grace is still open: it only closes because a
      // tick runs, and the tick can be arbitrarily late (iOS suspends the app once the
      // timer has paused the audio; a hidden web tab throttles setInterval). Picking the
      // phone up hours later is exactly the motion the shake detector is tuned for, so
      // check the clock too - otherwise a stale grace starts the book playing out loud.
      if (phase === 'grace' && Date.now() >= graceDeadline(get())) {
        closeGrace(get()); // the window closed unshaken, however late we noticed
        return;
      }
      const wasPaused = phase === 'grace';
      // A shake or a tap: the listener is awake right here (`last-interaction`).
      noteInteraction();
      if (origin.kind === 'duration') get().startDuration(origin.minutes);
      // The listener asked for one more chapter, so the end of the book is an answer they
      // would accept - unlike the automatic arm, which must not be handed one.
      else get().startChapterTimer({ allowEndOfBook: true });
      if (wasPaused) resumePlayback();
    },

    cancel: () => get().endTimer('cancelled'),

    endTimer: (reason, fellAsleep) => {
      const { bookKey } = get();
      stopCountdown();
      set({ ...IDLE });
      // Idle now, so this stops the fade ticker and hands the volume back. Belt and
      // braces on the paths that restored it already (firing does), but it is the last
      // point at which a stuck fade gain could still be corrected automatically.
      syncFade();
      // A timer armed with nothing loaded has no book to attribute the ending to, and
      // every subscriber is per-book - so there is nothing to tell anyone about.
      if (bookKey === null) return;
      const outcome: SleepOutcome = fellAsleep
        ? { bookKey, reason, fellAsleep }
        : { bookKey, reason };
      for (const listener of endedListeners) listener(outcome);
    },

    tick: () => {
      const first = get();
      // Before anything else: a timer whose book has been replaced (or ended) is over.
      // The tick is the choke point every timer passes through, whichever kind it is.
      if (cancelIfBookChanged(first)) return;
      if (first.phase === 'grace') {
        // Post-pause grace: nothing is counting down towards a pause any more, we are
        // only holding the window open for a shake. `syncGrace` closes it once due (and
        // notices a listener stirring that the watch missed).
        syncGrace();
        const state = get();
        if (state.phase === 'grace') {
          set({
            remaining: Math.max(0, Math.round((graceDeadline(state) - Date.now()) / 1000)),
          });
        }
        return;
      }
      if (first.phase === 'idle') return;
      // The second half of the freeze: the watch catches the pause/resume the moment it
      // happens, and this catches everything the watch could not - a resume the app slept
      // through, a state the engine only reported to itself. Runs BEFORE the countdown is
      // read, because it can slide `endsAt` (or re-arm the timer outright).
      syncPlaybackFreeze();
      // Re-read: the reconcile above may have rewritten `endsAt`, the phase, or cancelled.
      const state = get();
      // One path for both kinds of timer: `preciseRemaining` already dispatches on
      // which target is set, and both kinds then do the same four things.
      const precise = preciseRemaining(state);
      if (precise === null) return;
      const remaining = Math.max(0, Math.round(precise));
      set({ remaining });
      // Half a second, not zero: a duration timer used to fire once its ROUNDED
      // countdown hit 0, i.e. up to 500ms before `endsAt`, and that threshold is what
      // the tick cadence is built around. (For a position timer the two are the same:
      // it is within half a second of a target it will cross regardless.)
      //
      // A frozen countdown never fires: it is holding the last seconds of the listener's
      // time for them, and firing would pause a book that is already paused (see `fire`,
      // which would then simply drop the timer) instead of waiting for the resume.
      if (precise <= 0.5 && state.frozenAt === null) get().fire();
      else syncEndingPhase(remaining);
    },

    fire: () => {
      // The ONE site that stops the fade ticker by hand instead of through `syncFade`:
      // the restore is deliberately deferred until after the pause resolves (below), so
      // the reconciler - which stops the ticker and restores the volume together - would
      // blast the last instant of audio back to full volume.
      fadeTicker.stop();
      const player = usePlayer.getState();
      // The grace window exists to undo a pause THIS timer performed. A target can still
      // be reached against a book that is NOT playing - a chapter target crossed by a
      // scrub while paused, a book stopped between the tick and this call - and
      // `store.pause()` no-ops when already paused. Opening the grace then would arm the
      // accelerometer on a book nobody is listening to, and the next jostle would start
      // it playing out loud. Nothing was stopped, so the timer is simply over.
      // Recorded as `expired`: it reached the target it was armed for, which is the
      // timer running its course however little it had left to stop.
      // (The `nowPlaying` half is defensive: with nothing loaded the timer has already
      // been ended by `cancelIfBookChanged` before the tick could get here.)
      if (!player.nowPlaying || !selectIsTransportLive(player)) {
        get().endTimer('expired');
        return;
      }
      // Recorded BEFORE pausing: the pause is itself a transport edge the interaction
      // watch would record as a touch, and the listener's last touch is what was before it.
      const bookKey = get().bookKey;
      const fired: Fired = {
        at: Date.now(),
        stoppedAt: selectBookPosition(player),
        touch: bookKey === null ? null : lastInteraction(bookKey),
        stirred: false,
      };
      // Pause FIRST, then restore the gain. The other order would blast the last
      // instant of audio back to full volume, and skipping the restore would leave a
      // manual resume silently muted - so it is chained onto the pause, not dropped,
      // even if the pause rejects.
      void (async () => {
        try {
          await player.pause();
        } finally {
          restoreVolume();
        }
      })();
      set({
        phase: 'grace',
        endsAt: null,
        frozenAt: null,
        pauseAtPosition: null,
        remaining: GRACE_SECONDS,
        graceUntil: Date.now() + GRACE_SECONDS * 1000,
        fired,
      });
      startCountdown(); // keeps ticking to expire the grace
    },
  };
});

/** Resume after the timer paused playback. The player store has no bare `play`
 * action, and `toggle` from a paused state resumes - but it would PAUSE a book the
 * listener already resumed by hand during the grace, so the live state is checked.
 *
 * "Live" is `selectIsTransportLive` (see `store.ts`): a book still buffering its way
 * back has nothing left for us to resume either. */
function resumePlayback() {
  const player = usePlayer.getState();
  // Nothing loaded (the book ended, or playback was stopped): `toggle` would start a
  // reset engine from nowhere and the stall watchdog would surface a spurious playback
  // error three seconds later.
  if (!player.nowPlaying || selectIsTransportLive(player)) return;
  void player.toggle();
}

// --- selectors -------------------------------------------------------------

export const selectSleepPhase = (s: SleepTimerState): SleepPhase => s.phase;

/** Can a shake / "keep listening" tap do anything right now? Also gates the
 * accelerometer listener, so the sensor only runs in these two short windows. */
export const selectSleepExtendable = (s: SleepTimerState): boolean =>
  s.phase === 'ending' || s.phase === 'grace';
