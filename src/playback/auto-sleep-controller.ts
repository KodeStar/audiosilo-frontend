import { isCarConnected } from '@/car/car-connection';
import { withinAutoSleepWindow } from '@/lib/hhmm';
import { activeProfile, useProfiles } from '@/stores/profiles';
import { useSettings } from '@/stores/settings';

import {
  type AutoSleepDecision,
  canAutoSleepArm,
  decideAutoSleep,
  EMPTY_AUTO_SLEEP_MEMORY,
  recordAutoSleepOutcome,
  type AutoSleepMemory,
} from './auto-sleep';
import { engineTicker } from './engine-ticks';
import { onSleepTimerEnded, useSleepTimer } from './sleep-timer';
import { selectBookKey, selectIsPlaying, usePlayer } from './store';

/**
 * How often playback that is ALREADY running re-checks the window. The play edge alone
 * would miss the commonest case the feature exists for: starting a book at 21:30 and
 * listening into a 22:00 window, where no transition into `playing` ever happens again.
 * A minute matches the window's own minute granularity, arming up to 60s late is
 * imperceptible against a 15+ minute timer, and each check is a handful of field reads.
 * The poll runs ONLY while the engine is playing, only while the feature is switched
 * ON, and only while the current book could still be armed.
 */
const POLL_MS = 60_000;

/**
 * The session's anti-nag memory: the books the listener has cancelled a timer on (see
 * `auto-sleep.ts`, which owns the rules; this module only folds outcomes in and reads
 * the answer).
 *
 * Module state, so the promise it makes - "never again for this book, for the rest of
 * the session" - lasts as long as the JS context does. It used to live in a component's
 * ref, where it would have been lost by any remount; nothing remounts the root today,
 * so this is the same guarantee made structurally rather than by luck. It deliberately
 * survives `startAutoSleep`'s teardown too: stopping and restarting the controller is
 * not the listener changing their mind.
 */
let blocked: AutoSleepMemory = EMPTY_AUTO_SLEEP_MEMORY;

/** Kids mode's bedtime ends here, local time: from the profile's bedtime until this, a
 * story that starts or resumes gets a sleep timer (Phase 8). */
export const KIDS_BEDTIME_UNTIL = '06:00';

/** How long a story plays at bedtime before the timer fades it out (a duration timer, so
 * it fades like any other). */
export const KIDS_BEDTIME_MINUTES = 20;

/** Whether `now` (local wall clock) is inside a kids profile's bedtime window, from
 * `bedtime` ('HH:MM') until `KIDS_BEDTIME_UNTIL`, across midnight. A bedtime of 06:00
 * itself is a zero-length window (never), as `withinAutoSleepWindow` reads it. */
export function isBedtime(bedtime: string, now: Date): boolean {
  return withinAutoSleepWindow(bedtime, KIDS_BEDTIME_UNTIL, now);
}

/**
 * The bedtime rule of a kids profile: inside its window, every story that starts or
 * resumes gets a `KIDS_BEDTIME_MINUTES` timer, unless the book is blocked for the session
 * (a timer on it was cancelled: the same anti-nag rule as the setting's). Pure. It
 * REPLACES the device-wide auto sleep setting while a kids profile is active (a grown-up's
 * "end of chapter from 22:00" is not a child's bedtime), and the setting is untouched for
 * everyone else.
 */
export function decideBedtime(input: {
  bedtime: string;
  now: Date;
  bookKey: string | null;
  memory: AutoSleepMemory;
}): AutoSleepDecision {
  if (!canAutoSleepArm(input.memory, input.bookKey)) return { arm: 'none' };
  if (!isBedtime(input.bedtime, input.now)) return { arm: 'none' };
  return { arm: 'duration', minutes: KIDS_BEDTIME_MINUTES };
}

/** The active profile's kids bedtime, or null for a grown-up (or no profile). */
function kidsBedtime(): string | null {
  return activeProfile()?.kids?.bedtime ?? null;
}

/** Whether anything can arm right now: the device-wide setting is on, or the active
 * profile is in kids mode (whose bedtime rule is always on). */
function autoSleepOn(): boolean {
  return kidsBedtime() !== null || useSettings.getState().autoSleepTimer;
}

/** The decision for the book playing now: the kids profile's bedtime rule, else the
 * device-wide setting's. */
function decideNow(bookKey: string | null): AutoSleepDecision {
  const now = new Date();
  const bedtime = kidsBedtime();
  if (bedtime !== null) return decideBedtime({ bedtime, now, bookKey, memory: blocked });
  const settings = useSettings.getState();
  return decideAutoSleep({
    enabled: settings.autoSleepTimer,
    from: settings.autoSleepFrom,
    until: settings.autoSleepUntil,
    type: settings.autoSleepType,
    now,
    bookKey,
    memory: blocked,
  });
}

/**
 * Run the nightly auto sleep timer for the life of the app. Returns a teardown.
 *
 * Framework-free on purpose: it uses no context, router, props or rendering, so it is a
 * module with subscriptions rather than a component that renders `null` (the shape
 * `progress-sync.ts` and the downloads store's `useDownloads.subscribe` already use).
 * `src/app/_layout.tsx` starts it, which is only where the app's lifetime is expressed -
 * it is not React state, and nothing re-renders because of it.
 *
 * It listens to three things:
 * 1. the SETTING, which attaches/detaches the player watch (and takes effect the moment
 *    it is switched on, rather than at the next play edge), and the active PROFILE: a
 *    kids profile's bedtime rule (`decideBedtime`) replaces the setting while it is the
 *    active one, and is always on;
 * 2. the PLAYER, for the transition into `playing` (see `watchPlayer`);
 * 3. the sleep timer's one event, `onSleepTimerEnded`, for how each timer ended.
 *
 * The ending subscription is installed whether or not the feature is on: a cancellation
 * is the listener saying "not on this book", and it counts even if they enable auto
 * sleep later in the same session. It costs nothing when no timer ever ends.
 *
 * ## Everything except the memory is PER CALL
 *
 * The poll and the player subscription are created here, inside the call, and closed
 * over by the handlers below - not held in module variables. There is one call site
 * today, so a second live controller is not a thing that happens; module handles made it
 * a thing that could not happen SAFELY. `watchPlayer`'s "already watching, nothing to do"
 * guard was written for one controller's repeated switch-on, and with a shared handle a
 * second controller would read the first one's subscription as its own, install nothing,
 * and then be silently unhooked when the FIRST one was torn down - blind to every play
 * edge until the setting was toggled, with no error and nothing to see in the state. One
 * poll shared between two controllers has the same shape: either one's `poll.stop()`
 * stops the other's re-check.
 *
 * Per-call handles make two controllers simply two controllers (they would arm the same
 * one timer, since `armIfDue` gates on the live timer store), and a teardown can only
 * ever undo what its own call installed. The session memory stays module state on
 * purpose - see `blocked`.
 */
export function startAutoSleep(): () => void {
  /** The 60s re-check while a book plays on. Idempotent to start (see `ticker`), which is
   * what this needs: several edges call for it and none of them may push the next check
   * out. An `engineTicker`, so the engine's events run it where Android has paused the JS
   * timers (screen off): the window still opens on a book playing into it. */
  const poll = engineTicker(() => armIfDue(), POLL_MS);

  /** This controller's player subscription, installed only while the feature is on (see
   * `watchPlayer`). */
  let unwatchPlayer: (() => void) | null = null;

  /**
   * Arm an automatic timer for the book playing right now, if every rule says so.
   *
   * The one rule enforced HERE rather than in the pure `decideAutoSleep` is "the
   * listener's own timer always wins": a timer that is running, ending or in its grace
   * window IS this book's timer for this stretch of playback, whoever armed it, and an
   * automatic one must never land on top of it. It is a live reading of the timer store
   * (`phase !== 'idle'`) rather than anything remembered - a remembered copy can go
   * stale, a read of the store cannot.
   */
  function armIfDue() {
    const timer = useSleepTimer.getState();
    if (timer.phase !== 'idle') {
      // Nothing can change the answer for this book while its timer stands, so stop
      // asking. The poll restarts from the play edge that follows, or from the ending.
      poll.stop();
      return;
    }
    // Never in a car (CarPlay, Android Auto): the nightly timer is for listening in bed, and
    // one that fades and pauses the book mid-drive sends the driver to the phone. The poll
    // goes on, so a book still playing once the car is gone is armed then.
    if (isCarConnected()) return;
    // A kids profile's bedtime rule, else the device-wide setting (`decideNow`).
    const decision = decideNow(selectBookKey(usePlayer.getState()));
    if (decision.arm === 'none') return;
    if (decision.arm === 'duration') timer.startDuration(decision.minutes);
    // No options, which is `allowEndOfBook: false` said quietly: an automatic arm may
    // never aim at the end of the BOOK. On a chapterless book that target is hours away,
    // so the timer never fires, never returns the store to `idle`, and the "a timer
    // already stands" guard above then blocks every later arm for the rest of the night.
    // A short duration timer is `startChapterTimer`'s fallback instead - see
    // `ChapterTimerOptions`.
    else timer.startChapterTimer();
    poll.stop(); // a timer stands now; the play edge after it ends is what re-arms
  }

  /**
   * Start the 60s re-check, unless nothing could come of it. Every gate here is a
   * "re-asking cannot change the answer" test: the feature is off (it defaults to OFF, so
   * without this gate every listening session in the app would pay a 60s wakeup to
   * compute `{ arm: 'none' }`), a timer already stands, or this book is blocked for the
   * session.
   */
  function startPolling() {
    if (!autoSleepOn()) return;
    if (useSleepTimer.getState().phase !== 'idle') return;
    if (!canAutoSleepArm(blocked, selectBookKey(usePlayer.getState()))) return;
    poll.start();
  }

  /**
   * Watch the transport for the transition into `playing` - the edge that arms - and stop
   * polling for a book that is not playing.
   *
   * Attached and detached with the SETTING, not for the process lifetime:
   * `autoSleepTimer` defaults to false, and this callback would otherwise run on every
   * progress write (~3,600/h on native, ~14,400/h on web) only to compare two booleans
   * for a feature the listener has not switched on.
   */
  function watchPlayer() {
    if (unwatchPlayer) return; // this controller's own watch is already attached
    unwatchPlayer = usePlayer.subscribe((state, prev) => {
      const playing = selectIsPlaying(state);
      if (playing === selectIsPlaying(prev)) return; // not a transition; ignore progress ticks
      if (playing) {
        // Transition EDGE into playing: check now, then keep checking while it plays.
        armIfDue();
        startPolling();
      } else {
        poll.stop(); // nothing to arm for a book that isn't playing
      }
    });
    // Already playing when we attached (the app started mid-book, or the listener just
    // switched the feature on): adopt the same footing as a play edge rather than waiting
    // for the next transition.
    if (selectIsPlaying(usePlayer.getState())) {
      armIfDue();
      startPolling();
    }
  }

  function stopWatchingPlayer() {
    unwatchPlayer?.();
    unwatchPlayer = null;
    poll.stop();
  }

  /** Attach or detach the player watch to follow `autoSleepOn()`: the setting, or a kids
   * profile becoming (or no longer being) the active one. */
  let on = autoSleepOn();
  function follow() {
    const next = autoSleepOn();
    if (next === on) return;
    on = next;
    if (next) watchPlayer();
    else stopWatchingPlayer();
  }

  const unsubscribeSettings = useSettings.subscribe((state, prev) => {
    if (state.autoSleepTimer !== prev.autoSleepTimer) follow();
  });
  // Kids mode is a property of the active profile: switching to or from a kids profile
  // (or turning kids mode on or off) changes which rule applies, and whether any does.
  const unsubscribeProfiles = useProfiles.subscribe(() => follow());

  const unsubscribeEnded = onSleepTimerEnded((outcome) => {
    blocked = recordAutoSleepOutcome(blocked, outcome.bookKey, outcome.reason);
    if (outcome.reason === 'cancelled') {
      // Final for this book: there is nothing left for the poll to decide until a
      // different book plays, and the play edge catches that.
      poll.stop();
      return;
    }
    // It ran its course. Firing pauses playback, so the usual next thing is a play edge -
    // which arms the fresh timer, and is the reason a fired timer can never re-arm itself
    // into a loop. The exception is a listener who resumed by hand during the grace
    // window: they are playing with nothing armed and no edge is coming, so the poll has
    // to be the one that notices.
    if (selectIsPlaying(usePlayer.getState())) startPolling();
  });

  if (on) watchPlayer();

  return () => {
    unsubscribeSettings();
    unsubscribeProfiles();
    unsubscribeEnded();
    stopWatchingPlayer();
  };
}
