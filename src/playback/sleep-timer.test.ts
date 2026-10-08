import type { Chapter } from '@/api/types';
import { playerStoreMock, type MockNowPlaying } from '@/testing/player-store-mock';

// The sleep timer reads the player store for `nowPlaying`, the book position, the
// transport state, `pause`/`toggle` and the fade's `setOutputVolume`, and it SUBSCRIBES
// to it (that is how the countdown freezes the instant playback stops). The shared
// double is a real zustand store, so those subscription semantics are the production
// ones - see `@/testing/player-store-mock`.
jest.mock('@/playback/store', () =>
  // `require` (not an import) because a jest.mock factory is hoisted above every import
  // and may not close over module-scope bindings.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

const player = playerStoreMock();
const { pause: mockPause, toggle: mockToggle, setVolume: mockSetVolume } = player.spies;

/** A loaded book, identified the way the app identifies content: `contentKey`. */
function book(path: string, queue: { chapters: Chapter[]; total: number }): MockNowPlaying {
  return { connectionId: 'srv-1', libraryId: 1, path, queue };
}
const BOOK_A = () => book('author/book-a.m4b', { chapters: [], total: 0 });

// Imported after the mock setup (the factory closes over the mock-prefixed vars).
/* eslint-disable import/first */
import { engineTick } from '@/playback/engine-ticks';
import { noteInteraction, resetInteractions } from '@/playback/last-interaction';
import {
  ABANDON_AFTER_PAUSE_SECONDS,
  chapterSleepLabel,
  fadeGain,
  FADE_SECONDS,
  GRACE_SECONDS,
  onSleepTimerEnded,
  RESET_AFTER_PAUSE_SECONDS,
  selectSleepExtendable,
  selectSleepPhase,
  useSleepTimer,
  type SleepLabel,
  type SleepOutcome,
} from '@/playback/sleep-timer';
/* eslint-enable import/first */

const NOW = 1_700_000_000_000; // fixed epoch ms

/**
 * Change the engine's play state the way the real store does: write the snapshot AND
 * notify the subscribers. The timer freezes/thaws off this, so a test that sets the
 * field alone is testing the slower "the tick noticed eventually" path (which several
 * of the older tests below deliberately still do).
 */
const setPlayState = (state: string) => player.setPlayState(state);

/** The same write WITHOUT notifying - the state simply changed under a timer that was
 * not watching for it, which is how the tests below reach the tick's backstop path. */
const setPlayStateSilently = (state: string) =>
  player.patch({ snapshot: { ...player.usePlayer.getState().snapshot, state } });

/** Where the book is on the whole-book timeline (what `selectBookPosition` reads). */
const setPosition = (position: number) => player.patch({ bookPosition: position });

/** Load a book, without notifying: the tests that swap the book mid-timer are about the
 * timer's own tickers noticing, not about a store notification. */
const setBook = (nowPlaying: MockNowPlaying | null) => player.patch({ nowPlaying });

/** Move the wall clock WITHOUT running any timers - the app suspended (iOS stops
 * scheduling once we stop producing audio) or a hidden tab was throttled to nothing. */
function suspendFor(ms: number) {
  jest.setSystemTime(Date.now() + ms);
}

/** The gain most recently written to the engine, or null if none was. */
function lastVolume(): number | null {
  const calls = mockSetVolume.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}

/**
 * The quietest gain written to the engine since the mock was last cleared - 1 when
 * the timer never touched the volume at all. That is the assertion an end-of-chapter
 * timer has to satisfy: not "it ends at full volume" but "it was never below full",
 * so the last words of the chapter can't dip even for one 250ms step.
 */
function quietestVolume(): number {
  return mockSetVolume.mock.calls.reduce((min, [volume]) => Math.min(min, volume), 1);
}

/** Let the fire path's `pause().finally(restore)` microtasks settle. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

/** The label descriptor the sheet would hand `startUntilPosition` for a chapter. */
function endOf(chapter: string): SleepLabel {
  return { key: 'player.sleepTimer.endOf', params: { chapter } };
}

/** A chapter on the whole-book timeline: `book_offset` .. `book_offset + (end - start)`. */
function chapter(index: number, offset: number, length: number): Chapter {
  return {
    index,
    title: `Chapter ${index + 1}`,
    file_index: 0,
    file_path: 'book.m4b',
    start: 0,
    end: length,
    book_offset: offset,
  };
}

describe('sleep timer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    player.reset();
    resetInteractions();
    setBook(BOOK_A());
    setPlayStateSilently('playing');
    useSleepTimer.getState().cancel();
    player.dropSubscribers(); // the cancel above already dropped the timer's own
    // Cleared AFTER the cancel above, whose volume restore is not part of any test.
    player.clearSpies();
  });

  afterEach(() => {
    useSleepTimer.getState().cancel();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('fires a duration timer after the configured minutes elapse', () => {
    useSleepTimer.getState().startDuration(1); // 1 minute
    expect(useSleepTimer.getState().phase).toBe('running');
    expect(useSleepTimer.getState().endsAt).toBe(NOW + 60_000);

    // Advance 59s: the 1s tick updates remaining but hasn't fired yet (1s left, so
    // it is deep in the ending window by now).
    jest.advanceTimersByTime(59_000);
    expect(mockPause).not.toHaveBeenCalled();
    expect(useSleepTimer.getState().phase).toBe('ending');

    // Cross the full minute: pause is called and the countdown deactivates (the
    // timer moves into its post-pause grace window).
    jest.advanceTimersByTime(1_000);
    expect(mockPause).toHaveBeenCalledTimes(1);
    expect(useSleepTimer.getState().endsAt).toBeNull();
    expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');
  });

  it('fires an until-position timer when the book position crosses the target', () => {
    setPosition(100);
    useSleepTimer.getState().startUntilPosition(160, endOf('Chapter 12'));
    expect(useSleepTimer.getState().phase).toBe('running');
    expect(useSleepTimer.getState().pauseAtPosition).toBe(160);
    expect(useSleepTimer.getState().label).toEqual(endOf('Chapter 12'));

    // Position still short of the target: a tick updates remaining, no pause (10s
    // out, so inside the ending window).
    setPosition(150);
    jest.advanceTimersByTime(1_000);
    expect(mockPause).not.toHaveBeenCalled();
    expect(useSleepTimer.getState().remaining).toBe(10);

    // Position reaches/passes the target: pause and deactivate.
    setPosition(160);
    jest.advanceTimersByTime(1_000);
    expect(mockPause).toHaveBeenCalledTimes(1);
    expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');
    expect(useSleepTimer.getState().pauseAtPosition).toBeNull();
  });

  it('scales the until-position countdown by the playback rate (wall-clock time)', () => {
    setPosition(0);
    player.patch({ rate: 2 }); // 120s of remaining audio = 60s of real time at 2x
    useSleepTimer.getState().startUntilPosition(120, endOf('Chapter 12'));
    expect(useSleepTimer.getState().remaining).toBe(60);

    // A tick keeps it in wall-clock terms too.
    setPosition(40);
    jest.advanceTimersByTime(1_000);
    expect(useSleepTimer.getState().remaining).toBe(40); // (120 - 40) / 2

    // The pause still fires strictly by position, regardless of rate.
    setPosition(120);
    jest.advanceTimersByTime(1_000);
    expect(mockPause).toHaveBeenCalledTimes(1);
  });

  it('does not start an until-position timer when nothing is playing', () => {
    setBook(null);
    useSleepTimer.getState().startUntilPosition(100, endOf('x'));
    expect(useSleepTimer.getState().phase).toBe('idle');
  });

  // --- labels ---------------------------------------------------------------

  describe('labels', () => {
    it('describes a duration timer by key, not as a rendered string', () => {
      useSleepTimer.getState().startDuration(30);
      // A descriptor, so the UI re-renders it in the new language after a switch and
      // this framework-free store never touches i18next.
      expect(useSleepTimer.getState().label).toEqual({
        key: 'player.sleepTimer.minutes',
        params: { count: 30 },
      });
    });

    it('prettifies a titled chapter and numbers an untitled one', () => {
      expect(chapterSleepLabel({ ...chapter(4, 0, 600), title: 'ch_05_the-end.mp3' })).toEqual({
        key: 'player.sleepTimer.endOf',
        params: { chapter: 'ch 05 the-end' },
      });
      // No nested t(): one key that takes the number directly.
      expect(chapterSleepLabel({ ...chapter(4, 0, 600), title: '' })).toEqual({
        key: 'player.sleepTimer.endOfChapterNumber',
        params: { number: 5 },
      });
    });

    it('clears the label when the timer is cancelled', () => {
      useSleepTimer.getState().startDuration(30);
      useSleepTimer.getState().cancel();
      expect(useSleepTimer.getState().label).toBeNull();
    });
  });

  // --- fade-out (duration timers only) -------------------------------------

  // Android pauses every JS timer with the screen off, so neither ticker's interval fires
  // there; the engine's progress events (one a second while playing) still arrive, and the
  // store hands each to `engineTick`. `screenOff` moves the clock without running a single
  // timer and delivers those events.
  describe('with the screen off (JS timers paused, engine events only)', () => {
    function screenOff(seconds: number) {
      for (let i = 0; i < seconds; i++) {
        suspendFor(1_000);
        engineTick();
      }
    }

    /** Count the countdown's runs: the ticker reads `tick` off the store each time. */
    function countTicks() {
      const real = useSleepTimer.getState().tick;
      const tick = jest.fn(real);
      useSleepTimer.setState({ tick });
      return { tick, restore: () => useSleepTimer.setState({ tick: real }) };
    }

    it('reaches its ending, fades and pauses the book from the events alone', async () => {
      useSleepTimer.getState().startDuration(1);
      screenOff(31);
      expect(useSleepTimer.getState().phase).toBe('ending');
      screenOff(15);
      expect(lastVolume()!).toBeCloseTo(0.25, 1);
      screenOff(14);
      await flush();
      expect(mockPause).toHaveBeenCalledTimes(1);
      expect(useSleepTimer.getState().phase).toBe('grace');
      expect(lastVolume()).toBe(1); // handed back after the pause
    });

    it('counts down once a second when its ticker and the events both run', () => {
      const { tick, restore } = countTicks();
      useSleepTimer.getState().startDuration(5);
      for (let i = 0; i < 10; i++) {
        jest.advanceTimersByTime(500);
        engineTick();
        jest.advanceTimersByTime(500); // the ticker's own turn
      }
      expect(tick).toHaveBeenCalledTimes(10);
      restore();
    });

    it('runs nothing from the events while no timer is armed', () => {
      const { tick, restore } = countTicks();
      screenOff(5);
      useSleepTimer.getState().startDuration(5);
      useSleepTimer.getState().cancel();
      screenOff(5);
      expect(tick).not.toHaveBeenCalled();
      expect(mockSetVolume).not.toHaveBeenCalled();
      restore();
    });
  });

  describe('fade-out (duration timers)', () => {
    it('is a squared curve that reaches silence', () => {
      expect(fadeGain(FADE_SECONDS)).toBe(1);
      expect(fadeGain(FADE_SECONDS * 2)).toBe(1); // outside the window: full volume
      expect(fadeGain(FADE_SECONDS / 2)).toBeCloseTo(0.25); // squared, not linear (0.5)
      expect(fadeGain(0)).toBe(0);
      expect(fadeGain(-5)).toBe(0);
    });

    it('begins with 30s left and ramps the gain to ~0 by the time it fires', () => {
      useSleepTimer.getState().startDuration(1);
      // 29s in: 31s left, outside the fade window.
      jest.advanceTimersByTime(29_000);
      expect(useSleepTimer.getState().phase).toBe('running');
      expect(selectSleepExtendable(useSleepTimer.getState())).toBe(false);

      // The tick that leaves exactly FADE_SECONDS enters the ending phase and, for a
      // duration timer, starts the ramp.
      jest.advanceTimersByTime(1_000);
      expect(useSleepTimer.getState().phase).toBe('ending');
      expect(useSleepTimer.getState().remaining).toBe(FADE_SECONDS);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('ending');

      // Half way through the fade the gain is well down but not silent.
      jest.advanceTimersByTime(15_000);
      const half = lastVolume();
      expect(half).not.toBeNull();
      expect(half!).toBeCloseTo(0.25, 1);

      // By the last moments it is effectively silent.
      jest.advanceTimersByTime(14_750);
      expect(lastVolume()!).toBeLessThan(0.01);
    });

    it('leaves the ending window if the countdown climbs back out', () => {
      // An end-of-chapter timer 20s from its target is extendable immediately...
      setPosition(100);
      useSleepTimer.getState().startUntilPosition(120, endOf('Chapter 1'));
      expect(useSleepTimer.getState().phase).toBe('ending');

      // ...and a backward seek must take it back out, at full volume - a book left
      // quiet for the rest of a chapter is the failure this feature must not have.
      setPosition(0);
      jest.advanceTimersByTime(1_000);
      expect(useSleepTimer.getState().phase).toBe('running');
      expect(quietestVolume()).toBe(1);
    });

    it('restores the volume after firing, and only after pausing', async () => {
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(60_000);
      await flush();
      expect(mockPause).toHaveBeenCalledTimes(1);
      expect(lastVolume()).toBe(1);
      // Pause first, so the last instant of audio isn't blasted back to full volume.
      expect(mockPause.mock.invocationCallOrder[0]).toBeLessThan(
        mockSetVolume.mock.invocationCallOrder[mockSetVolume.mock.calls.length - 1],
      );
    });

    it('restores the volume when the timer is cancelled mid-fade', () => {
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(45_000);
      expect(useSleepTimer.getState().phase).toBe('ending');
      useSleepTimer.getState().cancel();
      expect(lastVolume()).toBe(1);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');
      // The fade ticker is gone: no further gain writes.
      mockSetVolume.mockClear();
      jest.advanceTimersByTime(5_000);
      expect(mockSetVolume).not.toHaveBeenCalled();
    });

    it('is back at full volume once the grace window closes unshaken', () => {
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(60_000 + GRACE_SECONDS * 1000);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');
      // The last exit path, and the last chance to correct a stuck gain: a listener who
      // resumes by hand tomorrow morning must not find the book playing near-silent.
      expect(lastVolume()).toBe(1);
      mockSetVolume.mockClear();
      jest.advanceTimersByTime(10_000);
      expect(mockSetVolume).not.toHaveBeenCalled();
    });
  });

  // --- end-of-chapter timers do NOT fade -----------------------------------

  describe('no fade for an end-of-chapter timer', () => {
    /** Three 10-minute chapters, so a shake always has a next chapter to retarget. */
    function chapteredBook() {
      return book('author/book-a.m4b', {
        chapters: [chapter(0, 0, 600), chapter(1, 600, 600), chapter(2, 1200, 600)],
        total: 1800,
      });
    }

    it('plays the last 30 seconds at full volume and stops at the boundary', async () => {
      setBook(chapteredBook());
      setPosition(540); // a minute out from the end of chapter 1
      useSleepTimer.getState().startUntilPosition(600, endOf('Chapter 1'));
      expect(useSleepTimer.getState().phase).toBe('running');

      // Walk the position up to the boundary a second at a time. The 250ms fade ticker
      // would have had ~120 chances to write a gain across the final window alone.
      for (let elapsed = 1; elapsed <= 60; elapsed += 1) {
        setPosition(540 + elapsed);
        jest.advanceTimersByTime(1_000);
        if (elapsed === 30) expect(useSleepTimer.getState().phase).toBe('ending');
      }
      await flush();

      // The chapter ended at full volume - those closing words are exactly what the
      // listener stayed awake for - and only THEN did playback stop.
      expect(quietestVolume()).toBe(1);
      expect(mockPause).toHaveBeenCalledTimes(1);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');

      // The grace window is just as quiet, and closes the same way a duration timer's
      // does.
      jest.advanceTimersByTime(GRACE_SECONDS * 1000);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');
      expect(quietestVolume()).toBe(1);
    });

    it('still becomes extendable, and a shake there retargets the next chapter', () => {
      setBook(chapteredBook());
      setPosition(580); // 20s from the end of chapter 1: inside the window
      useSleepTimer.getState().startUntilPosition(600, endOf('Chapter 1'));
      expect(useSleepTimer.getState().phase).toBe('ending');
      expect(selectSleepExtendable(useSleepTimer.getState())).toBe(true);

      useSleepTimer.getState().keepListening();
      const state = useSleepTimer.getState();
      expect(state.phase).toBe('running');
      expect(state.pauseAtPosition).toBe(1200); // the end of chapter 2
      expect(quietestVolume()).toBe(1); // nothing to restore, because nothing dipped
    });

    it('leaves the ending window while paused by hand, and re-enters it on resume', async () => {
      setBook(chapteredBook());
      setPosition(580); // 20s from the end of chapter 1: inside the window
      useSleepTimer.getState().startUntilPosition(600, endOf('Chapter 1'));
      expect(useSleepTimer.getState().phase).toBe('ending');

      // Paused by the listener, 20 seconds short: nothing is about to stop, so no
      // accelerometer and no grace card - on the pause itself, since the app may never
      // tick again once the audio stops.
      setPlayState('paused');
      expect(useSleepTimer.getState().phase).toBe('running');
      expect(selectSleepExtendable(useSleepTimer.getState())).toBe(false);
      // The tick must not put it straight back.
      jest.advanceTimersByTime(5 * 60_000);
      expect(useSleepTimer.getState().phase).toBe('running');
      expect(selectSleepExtendable(useSleepTimer.getState())).toBe(false);

      // A shake there does nothing: it would retarget the next chapter without resuming.
      useSleepTimer.getState().keepListening();
      expect(mockToggle).not.toHaveBeenCalled();
      expect(useSleepTimer.getState().pauseAtPosition).toBe(600);

      // Resumed still 20s out: back in the window on the event, still aimed at chapter 1.
      setPlayState('playing');
      expect(useSleepTimer.getState().phase).toBe('ending');
      expect(selectSleepExtendable(useSleepTimer.getState())).toBe(true);
      setPosition(600);
      jest.advanceTimersByTime(1_000);
      await flush();
      expect(mockPause).toHaveBeenCalledTimes(1);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');
      expect(quietestVolume()).toBe(1);
    });

    it('armed inside the window while paused, waits for the resume to be extendable', () => {
      setBook(chapteredBook());
      setPosition(580);
      setPlayState('paused');
      useSleepTimer.getState().startUntilPosition(600, endOf('Chapter 1'));
      expect(useSleepTimer.getState().phase).toBe('running');
      expect(selectSleepExtendable(useSleepTimer.getState())).toBe(false);
      setPlayState('playing');
      expect(useSleepTimer.getState().phase).toBe('ending');
    });

    it('opens the same post-pause grace, where a shake resumes and retargets', async () => {
      setBook(chapteredBook());
      setPosition(595);
      useSleepTimer.getState().startUntilPosition(600, endOf('Chapter 1'));
      setPosition(600);
      jest.advanceTimersByTime(1_000);
      await flush();
      setPlayStateSilently('paused'); // the timer paused it
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');
      expect(useSleepTimer.getState().remaining).toBe(GRACE_SECONDS);

      jest.advanceTimersByTime((GRACE_SECONDS - 1) * 1000); // still open, as for a duration timer
      expect(selectSleepExtendable(useSleepTimer.getState())).toBe(true);

      useSleepTimer.getState().keepListening();
      expect(mockToggle).toHaveBeenCalledTimes(1); // resumed
      const state = useSleepTimer.getState();
      expect(state.phase).toBe('running');
      expect(state.pauseAtPosition).toBe(1200);
      expect(state.graceUntil).toBeNull();
      expect(quietestVolume()).toBe(1);
    });
  });

  // --- the countdown freezes while playback is paused ------------------------

  describe('freezing while paused', () => {
    it('does not advance a duration timer while playback is paused', () => {
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(10 * 60_000); // 10 minutes of listening
      expect(useSleepTimer.getState().remaining).toBe(20 * 60);

      setPlayState('paused');
      jest.advanceTimersByTime(10 * 60_000);
      // "30 minutes" means 30 minutes of LISTENING: ten paused minutes cost nothing,
      // and the timer is still armed rather than having silently lapsed.
      expect(useSleepTimer.getState().remaining).toBe(20 * 60);
      expect(useSleepTimer.getState().phase).toBe('running');
      expect(mockPause).not.toHaveBeenCalled();
    });

    it('fires only after the FULL duration of actual playing time', async () => {
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(10 * 60_000);

      setPlayState('paused');
      jest.advanceTimersByTime(10 * 60_000); // paused: buys no time at all
      setPlayState('playing');

      // The 20 minutes that were left are still 20 minutes of listening away.
      jest.advanceTimersByTime(20 * 60_000 - 1_000);
      expect(mockPause).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1_000);
      await flush();
      expect(mockPause).toHaveBeenCalledTimes(1);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');
    });

    it('freezes even when no tick runs at all while the app is suspended', async () => {
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(10 * 60_000);

      // The headphone-button pause: the store write is the last thing that happens
      // before iOS suspends us, so the freeze must be recorded from THAT, not from a
      // tick that is never going to run again.
      setPlayState('paused');
      suspendFor(15 * 60_000); // not one tick in a quarter of an hour
      setPlayState('playing');

      // The suspended time is not lost: still exactly the 20 minutes we had left.
      expect(useSleepTimer.getState().endsAt).toBe(Date.now() + 20 * 60_000);
      jest.advanceTimersByTime(20 * 60_000);
      await flush();
      expect(mockPause).toHaveBeenCalledTimes(1);
      expect(useSleepTimer.getState().origin).toEqual({ kind: 'duration', minutes: 30 });
    });

    it('still freezes from the tick alone when the watch never saw the pause', () => {
      // The freeze is reconciled from TWO places: the player-store watch (immediately)
      // and the 1s tick (the backstop). This covers the backstop on its own.
      //
      // It gets there by dropping the watch's subscription BEFORE the pause, which is
      // the reachable shape of "the watch did not see it": the watch is installed when
      // the countdown starts, so a stop written outside that window is one it can never
      // be told about. Writing the snapshot without notifying would not be - zustand
      // notifies synchronously on every `set`, so a store write cannot slip past a
      // listener that is actually subscribed.
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(10 * 60_000);
      player.dropSubscribers(); // nobody is watching the store any more
      setPlayState('paused');
      jest.advanceTimersByTime(5 * 60_000);
      // The tick caught it one second late, and the four minutes after that cost nothing.
      expect(useSleepTimer.getState().remaining).toBe(20 * 60 - 1);
      expect(useSleepTimer.getState().phase).toBe('running');
    });

    it('does not run long when a throttled tick arrives late while playing', () => {
      useSleepTimer.getState().startDuration(30);
      // A backgrounded web tab fires the 1s interval once a minute. The countdown is a
      // deadline, not a per-tick decrement, so the missing wakeups cost nothing.
      for (let minute = 0; minute < 10; minute += 1) jest.advanceTimersByTime(60_000);
      expect(useSleepTimer.getState().remaining).toBe(20 * 60);
    });

    it('re-arms the full original duration after a pause longer than the threshold', () => {
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(27 * 60_000); // 3 minutes left
      expect(useSleepTimer.getState().remaining).toBe(3 * 60);

      setPlayState('paused');
      suspendFor((RESET_AFTER_PAUSE_SECONDS + 1) * 1000);
      setPlayState('playing');

      // A three-minute rump firing part-way into tomorrow evening's session is not what
      // anyone asked for: this is a new sitting, so it gets the whole timer again.
      const state = useSleepTimer.getState();
      expect(state.remaining).toBe(30 * 60);
      expect(state.endsAt).toBe(Date.now() + 30 * 60_000);
      expect(state.phase).toBe('running');
      expect(state.frozenAt).toBeNull();
      expect(state.origin).toEqual({ kind: 'duration', minutes: 30 });
    });

    it('ends the timer outright when the freeze outlasts the abandon cap', () => {
      // Nothing ever cancels a frozen timer, so the re-arm above answers "same sitting?"
      // for a pause of ANY length: armed at 22:30, paused at 22:40, and the listener
      // picks the same book up at 08:00 - a full 30 minutes was re-armed and the book
      // faded out at 08:30, with no user action and hours outside the auto sleep window.
      const outcomes: SleepOutcome[] = [];
      const off = onSleepTimerEnded((outcome) => outcomes.push(outcome));
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(10 * 60_000);

      setPlayState('paused');
      suspendFor((ABANDON_AFTER_PAUSE_SECONDS + 60) * 1000); // resumed the next morning
      setPlayState('playing');
      off();

      // A timer you set last night is not a timer you set this morning.
      const state = useSleepTimer.getState();
      expect(state.phase).toBe('idle');
      expect(state.endsAt).toBeNull();
      expect(state.origin).toBeNull();
      // `expired`, not `cancelled`: nobody dismissed it, so auto sleep may still arm a
      // fresh one on tonight's terms.
      expect(outcomes).toEqual([{ bookKey: 'srv-1:1:author/book-a.m4b', reason: 'expired' }]);

      // And nothing is left to stop the book half an hour into the morning's listening.
      jest.advanceTimersByTime(31 * 60_000);
      expect(mockPause).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('never slides the deadline earlier when the device clock jumps backwards', () => {
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(10 * 60_000);
      const armed = useSleepTimer.getState().endsAt;

      setPlayState('paused');
      // The frozen span is two readings of a clock the DEVICE owns: an NTP correction or
      // a manual change between them makes it negative, and adding it moved `endsAt`
      // earlier. That is invisible until the clock is corrected back, at which point the
      // timer is suddenly minutes (or with a big jump, hours) closer than it ever was.
      jest.setSystemTime(Date.now() - 5 * 60_000);
      setPlayState('playing');

      expect(useSleepTimer.getState().endsAt).toBe(armed);
      expect(useSleepTimer.getState().frozenAt).toBeNull();
      expect(useSleepTimer.getState().phase).toBe('running');
      expect(mockPause).not.toHaveBeenCalled();
    });

    it('continues the frozen countdown after a pause shorter than the threshold', () => {
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(27 * 60_000);

      setPlayState('paused');
      suspendFor((RESET_AFTER_PAUSE_SECONDS - 60) * 1000); // a long phone call
      setPlayState('playing');

      // Still the same sitting - keep the countdown the listener was on.
      expect(useSleepTimer.getState().remaining).toBe(3 * 60);
      expect(useSleepTimer.getState().endsAt).toBe(Date.now() + 3 * 60_000);
    });

    it('leaves an end-of-chapter timer alone through all of it', async () => {
      setBook(
        book('author/book-a.m4b', {
          chapters: [chapter(0, 0, 600), chapter(1, 600, 600)],
          total: 1200,
        }),
      );
      setPosition(100);
      useSleepTimer.getState().startUntilPosition(600, endOf('Chapter 1'));

      // A position target does not advance while paused (nothing is playing), and it
      // stays valid however long the pause was - so there is nothing to freeze and
      // nothing to re-arm, however long the listener was away.
      setPlayState('paused');
      suspendFor(3 * 3600_000);
      setPlayState('playing');
      const state = useSleepTimer.getState();
      expect(state.frozenAt).toBeNull();
      expect(state.pauseAtPosition).toBe(600); // NOT retargeted at chapter 2
      expect(state.origin).toEqual({ kind: 'chapter' });

      // And it still fires exactly where it was aimed.
      setPosition(600);
      jest.advanceTimersByTime(1_000);
      await flush();
      expect(mockPause).toHaveBeenCalledTimes(1);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');
    });

    it('does not spend wall clock when armed while the book is paused', () => {
      setPlayState('paused');
      useSleepTimer.getState().startDuration(30);
      suspendFor(10 * 60_000);
      setPlayState('playing');
      // Setting a timer and then starting the book is an ordinary bedtime sequence; the
      // countdown must start when the audio does, not when the sheet closed.
      expect(useSleepTimer.getState().endsAt).toBe(Date.now() + 30 * 60_000);
    });

    // --- a pause that lands mid-fade ----------------------------------------

    it('hands the volume straight back when the pause lands mid-fade', () => {
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(45_000); // 15s left: ramped well down
      expect(useSleepTimer.getState().phase).toBe('ending');
      expect(lastVolume()!).toBeLessThan(0.3);

      setPlayState('paused');
      // Full volume immediately, and no further gain writes: the listener may hit play
      // on the next breath, and a book that resumes at a fifth of its volume for no
      // visible reason is exactly the failure this feature must never have.
      expect(lastVolume()).toBe(1);
      mockSetVolume.mockClear();
      jest.advanceTimersByTime(10_000);
      expect(mockSetVolume).not.toHaveBeenCalled();
      // Frozen, so it also cannot pause a book that is already paused.
      expect(mockPause).not.toHaveBeenCalled();
      // And it is out of the `ending` phase: the ramp is suspended and the volume is
      // back, so nothing about this timer is "about to stop" any more.
      expect(useSleepTimer.getState().phase).toBe('running');
    });

    it('leaves the ending phase while frozen, however long the book stays paused', () => {
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(40_000); // 20s left: ending, and fading
      expect(useSleepTimer.getState().phase).toBe('ending');
      expect(selectSleepExtendable(useSleepTimer.getState())).toBe(true);

      setPlayState('paused');
      // The 1s tick must not put it straight back either - it is the tick that used to
      // re-enter the phase on the very next second.
      jest.advanceTimersByTime(5 * 60_000);
      const frozen = useSleepTimer.getState();
      expect(frozen.phase).toBe('running');
      // Which is the whole point: `selectSleepExtendable` gates the accelerometer, so a
      // book paused with 20 seconds left would otherwise keep the sensor subscribed at
      // 10Hz for the rest of the session, with the badge solid pink and the sheet saying
      // "Fading out" about a paused book at full volume.
      expect(selectSleepExtendable(frozen)).toBe(false);

      // A shake there does nothing at all: it is not the grace window, so `keepListening`
      // would silently reset the timer to its full length without resuming playback.
      useSleepTimer.getState().keepListening();
      expect(mockToggle).not.toHaveBeenCalled();
      expect(useSleepTimer.getState().remaining).toBe(20);
      expect(useSleepTimer.getState().endsAt).toBe(frozen.endsAt);

      // The thaw re-enters it, because 20s left still warrants it.
      setPlayState('playing');
      expect(useSleepTimer.getState().phase).toBe('ending');
      expect(selectSleepExtendable(useSleepTimer.getState())).toBe(true);
    });

    it('picks the ramp up where it froze, without jumping', async () => {
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(45_000); // 15s left
      const frozenFrom = lastVolume()!;

      setPlayState('paused');
      suspendFor(60_000);
      setPlayState('playing');

      // Resumes at the gain those 15 remaining seconds imply - the same value it froze
      // at, not a restart of the ramp and not a jump to the end of it.
      expect(lastVolume()!).toBeCloseTo(frozenFrom, 5);
      expect(useSleepTimer.getState().phase).toBe('ending');

      // ...and it carries on down from there to silence, then stops as normal.
      jest.advanceTimersByTime(14_000);
      expect(lastVolume()!).toBeLessThan(frozenFrom);
      jest.advanceTimersByTime(1_000);
      await flush();
      expect(mockPause).toHaveBeenCalledTimes(1);
      expect(lastVolume()).toBe(1); // never left attenuated
    });

    it('re-arms at full volume when a mid-fade pause outlasts the threshold', () => {
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(30 * 60_000 - 10_000); // 10s left, deep in the fade
      expect(lastVolume()!).toBeLessThan(0.2);

      setPlayState('paused');
      suspendFor((RESET_AFTER_PAUSE_SECONDS + 60) * 1000);
      setPlayState('playing');

      const state = useSleepTimer.getState();
      expect(state.phase).toBe('running'); // out of the ending window entirely
      expect(state.remaining).toBe(30 * 60);
      expect(lastVolume()).toBe(1);
    });
  });

  // --- shake to keep listening ---------------------------------------------

  describe('keepListening', () => {
    it('is a no-op outside the ending and grace windows', () => {
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(10_000);
      const before = useSleepTimer.getState().endsAt;
      useSleepTimer.getState().keepListening();
      expect(useSleepTimer.getState().endsAt).toBe(before);
      expect(mockToggle).not.toHaveBeenCalled();
    });

    it('restarts the full original duration from inside the fade', () => {
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(30 * 60_000 - FADE_SECONDS * 1000); // into the ending window
      expect(useSleepTimer.getState().phase).toBe('ending');
      jest.advanceTimersByTime(5_000); // far enough in that the gain is really down
      expect(lastVolume()).toBeLessThan(1);

      useSleepTimer.getState().keepListening();
      const state = useSleepTimer.getState();
      expect(state.phase).toBe('running');
      // Out of the ending window, so a second shake can no longer do anything.
      expect(selectSleepExtendable(state)).toBe(false);
      expect(state.remaining).toBe(30 * 60); // the FULL original 30 minutes again
      expect(state.endsAt).toBe(Date.now() + 30 * 60_000);
      expect(lastVolume()).toBe(1);
      // Playback never stopped, so nothing to resume.
      expect(mockToggle).not.toHaveBeenCalled();
    });

    it('retargets a chapter timer to the end of the NEXT chapter', () => {
      setBook(
        book('author/book-a.m4b', {
          chapters: [chapter(0, 0, 600), chapter(1, 600, 600), chapter(2, 1200, 600)],
          total: 1800,
        }),
      );
      // 20s from the end of chapter 1 - i.e. inside the ending window.
      setPosition(580);
      useSleepTimer.getState().startUntilPosition(600, endOf('Chapter 1'));
      expect(useSleepTimer.getState().phase).toBe('ending');

      useSleepTimer.getState().keepListening();
      const state = useSleepTimer.getState();
      expect(state.pauseAtPosition).toBe(1200); // end of chapter 2
      expect(state.label).toEqual(endOf('Chapter 2')); // relabelled to the new target
      expect(state.origin).toEqual({ kind: 'chapter' });
      expect(state.phase).toBe('running');
      expect(quietestVolume()).toBe(1);
    });

    it('falls back to the end of the book in the last chapter', () => {
      setBook(
        book('author/book-a.m4b', {
          chapters: [chapter(0, 0, 600), chapter(1, 600, 600)],
          total: 2400,
        }),
      );
      setPosition(1180); // 20s from the last chapter's end (1200)
      useSleepTimer.getState().startUntilPosition(1200, endOf('Chapter 2'));
      useSleepTimer.getState().keepListening();
      expect(useSleepTimer.getState().pauseAtPosition).toBe(2400);
      expect(useSleepTimer.getState().label).toEqual({ key: 'player.sleepTimer.endOfBook' });
    });

    it('falls back to a 15 minute timer when the book is over too', () => {
      setBook(
        book('author/book-a.m4b', {
          chapters: [chapter(0, 0, 1200)],
          total: 1200,
        }),
      );
      setPosition(1190); // 10s left of both the chapter and the book
      useSleepTimer.getState().startUntilPosition(1200, endOf('Chapter 1'));
      useSleepTimer.getState().keepListening();
      const state = useSleepTimer.getState();
      expect(state.pauseAtPosition).toBeNull();
      expect(state.endsAt).toBe(Date.now() + 15 * 60_000);
      expect(state.origin).toEqual({ kind: 'duration', minutes: 15 });
    });

    it('re-arms AND resumes playback inside the post-pause grace window', async () => {
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(30 * 60_000);
      await flush();
      setPlayStateSilently('paused'); // the timer paused it
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');
      expect(selectSleepExtendable(useSleepTimer.getState())).toBe(true);

      useSleepTimer.getState().keepListening();
      expect(mockToggle).toHaveBeenCalledTimes(1); // resumed
      const state = useSleepTimer.getState();
      expect(state.phase).toBe('running');
      expect(state.graceUntil).toBeNull();
      expect(state.remaining).toBe(30 * 60);
      expect(lastVolume()).toBe(1);
    });

    it('does not toggle a book the listener already resumed by hand', async () => {
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(30 * 60_000);
      await flush();
      setPlayStateSilently('playing'); // resumed manually
      useSleepTimer.getState().keepListening();
      expect(mockToggle).not.toHaveBeenCalled();
      expect(useSleepTimer.getState().phase).toBe('running');
    });

    it('expires the grace window after GRACE_SECONDS', async () => {
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(60_000);
      await flush();
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');

      jest.advanceTimersByTime((GRACE_SECONDS - 1) * 1000);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');

      jest.advanceTimersByTime(1_000);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');
      expect(useSleepTimer.getState().graceUntil).toBeNull();
      expect(selectSleepExtendable(useSleepTimer.getState())).toBe(false);

      // Too late to shake now.
      useSleepTimer.getState().keepListening();
      expect(useSleepTimer.getState().phase).toBe('idle');
      expect(mockToggle).not.toHaveBeenCalled();
    });

    it('refuses a grace window that expired while the ticks were not running', async () => {
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(30 * 60_000);
      await flush();
      setPlayStateSilently('paused');
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');

      // The clock moves on without the ticker running - iOS suspends the app the moment
      // the timer pauses the audio, and a hidden web tab throttles setInterval. Picking
      // the phone up hours later is precisely the motion the shake detector looks for,
      // so the phase alone must not be enough to start the book playing again.
      jest.setSystemTime(Date.now() + 3 * 3600_000);
      useSleepTimer.getState().keepListening();
      expect(mockToggle).not.toHaveBeenCalled();
      expect(useSleepTimer.getState().phase).toBe('idle');
      expect(useSleepTimer.getState().graceUntil).toBeNull();
    });
  });

  // --- who asked decides how far a chapter timer may reach --------------------
  //
  // `startChapterTimer` serves two callers with one scan but two fallbacks: the
  // listener's "one more chapter" (which accepts the end of the book) and the automatic
  // nightly arm (which must not be handed a target hours away, because a timer that never
  // fires also never returns the store to `idle` - and the auto sleep controller then
  // blocks every later arm AND stops its poll, so the listener silently gets no working
  // sleep timer at all, all night).

  describe('startChapterTimer', () => {
    /** A folder of MP3s with no chapter metadata: `buildBookQueue` synthesizes virtual
     * chapters only for a SINGLE-file book, so `queue.chapters` really is empty here. */
    const chapterless = () => book('author/parts/', { chapters: [], total: 36_000 }); // 10h

    it('degrades an automatic arm on a chapterless book to a timer that fires', async () => {
      setBook(chapterless());
      setPosition(0);
      useSleepTimer.getState().startChapterTimer(); // the automatic arm's call

      const state = useSleepTimer.getState();
      expect(state.pauseAtPosition).toBeNull(); // NOT the end of the book, ten hours out
      expect(state.origin).toEqual({ kind: 'duration', minutes: 15 });
      expect(state.endsAt).toBe(NOW + 15 * 60_000);

      // The part that actually matters: it fires, so the timer returns to `idle` and the
      // controller can arm again later in the night.
      jest.advanceTimersByTime(15 * 60_000);
      await flush();
      expect(mockPause).toHaveBeenCalledTimes(1);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');
    });

    it('refuses a lone "chapter" that ends where the book does, on an automatic arm', () => {
      // A single-file book whose only chapter is the whole book: the end-of-book target
      // wearing a chapter's name, and just as many hours away.
      setBook(book('author/book-a.m4b', { chapters: [chapter(0, 0, 36_000)], total: 36_000 }));
      setPosition(0);
      useSleepTimer.getState().startChapterTimer();
      expect(useSleepTimer.getState().origin).toEqual({ kind: 'duration', minutes: 15 });
      expect(useSleepTimer.getState().pauseAtPosition).toBeNull();
    });

    it('still arms a real chapter boundary automatically', () => {
      setBook(
        book('author/book-a.m4b', {
          chapters: [chapter(0, 0, 600), chapter(1, 600, 600), chapter(2, 1200, 600)],
          total: 1800,
        }),
      );
      setPosition(0);
      useSleepTimer.getState().startChapterTimer();
      expect(useSleepTimer.getState().pauseAtPosition).toBe(600);
      expect(useSleepTimer.getState().origin).toEqual({ kind: 'chapter' });
    });

    it('keeps the end of the book for the listener, who asked for one more chapter', () => {
      setBook(chapterless());
      setPosition(0);
      useSleepTimer.getState().startChapterTimer({ allowEndOfBook: true });
      expect(useSleepTimer.getState().pauseAtPosition).toBe(36_000);
      expect(useSleepTimer.getState().label).toEqual({ key: 'player.sleepTimer.endOfBook' });
    });
  });

  // --- a buffering book is still a book being listened to ---------------------
  //
  // The timer reads the transport through `selectIsTransportLive` (`playing || loading`),
  // never `selectIsPlaying`. Collapsing the two would make every momentary buffer look
  // like a pause, which breaks the freeze in both directions.

  describe('the loose reading of the transport', () => {
    it('does not freeze - or slide the deadline - across a buffering stall', () => {
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(10 * 60_000);
      const endsAt = useSleepTimer.getState().endsAt;

      setPlayState('loading'); // the stream stalls for five seconds mid-chapter
      jest.advanceTimersByTime(5_000);
      expect(useSleepTimer.getState().frozenAt).toBeNull();
      expect(useSleepTimer.getState().remaining).toBe(20 * 60 - 5); // still counting down

      setPlayState('playing');
      // Read as a pause, each stall would hand those seconds back - so a book on a flaky
      // connection would keep sliding its deadline forward and outlast its own timer.
      expect(useSleepTimer.getState().endsAt).toBe(endsAt);
    });

    it('pauses and opens the grace when it fires during a buffer', async () => {
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(59_000);
      setPlayState('loading'); // buffering as the last second runs out
      jest.advanceTimersByTime(1_000);
      await flush();

      // The book is still a book being listened to, so this is a real stop with a real
      // grace window - not the "it fired against a book that was not playing" path, which
      // would drop the timer and leave the stream to resume and play on.
      expect(mockPause).toHaveBeenCalledTimes(1);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');
      expect(selectSleepExtendable(useSleepTimer.getState())).toBe(true);
    });
  });

  // --- the timer belongs to one book ---------------------------------------

  describe('book scoping', () => {
    it('records the book it was armed for', () => {
      useSleepTimer.getState().startDuration(30);
      expect(useSleepTimer.getState().bookKey).toBe('srv-1:1:author/book-a.m4b');
      useSleepTimer.getState().cancel();
      expect(useSleepTimer.getState().bookKey).toBeNull();
    });

    it('cancels itself when a different book starts, instead of pausing it', () => {
      setPosition(1000);
      useSleepTimer.getState().startUntilPosition(1800, endOf('Chapter 3'));
      expect(useSleepTimer.getState().phase).toBe('running');

      // The listener starts a different book, already further in than book A's target.
      setBook(book('author/book-b.m4b', { chapters: [], total: 20_000 }));
      setPosition(5400);
      jest.advanceTimersByTime(1_000);

      expect(mockPause).not.toHaveBeenCalled(); // book B is NOT paused seconds in
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');
      expect(useSleepTimer.getState().pauseAtPosition).toBeNull();
    });

    it('stops the fade and restores the volume as soon as the book changes', () => {
      // A duration timer 25s from firing: fading, so the gain is on its way down.
      // (A chapter timer would be at full volume here and have no ticker to stop.)
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(35_000);
      expect(useSleepTimer.getState().phase).toBe('ending');
      expect(lastVolume()!).toBeLessThan(1);

      // Book B starts mid-fade. The 250ms fade ticker gets there before the 1s
      // countdown does, so it has to notice on its own - otherwise it writes book A's
      // fade gain onto book B and the new book plays near-silent.
      mockSetVolume.mockClear();
      setBook(book('author/book-b.m4b', { chapters: [], total: 20_000 }));
      jest.advanceTimersByTime(250);
      // Not just "it ends at 1": no gain BELOW full is ever written once book B is the
      // book playing. (`playBook` re-asserts full volume itself, but only after it has
      // swapped `nowPlaying` - the swap is what makes this ticker stand down at all.)
      expect(quietestVolume()).toBe(1);
      expect(lastVolume()).toBe(1);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');

      // Nothing of ours is left ticking, at either cadence.
      mockSetVolume.mockClear();
      jest.advanceTimersByTime(10_000);
      expect(mockSetVolume).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('stops ticking when the book ends and nothing is playing', () => {
      // The ordinary end-of-book timer: `finishBook()` normally wins the race to the
      // target, nulls `nowPlaying`, and leaves the target permanently unreachable.
      setBook(
        book('author/book-a.m4b', {
          chapters: [chapter(0, 0, 1800)],
          total: 1800,
        }),
      );
      setPosition(1700);
      useSleepTimer.getState().startUntilPosition(1800, {
        key: 'player.sleepTimer.endOfBook',
      });

      setBook(null);
      setPosition(0); // `selectBookPosition` reads 0 with nothing loaded
      jest.advanceTimersByTime(1_000);

      // Idle, so the auto sleep controller reads "no timer standing" again and a later
      // book can still get its automatic timer, and no ticker is left running for the
      // process.
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');
      expect(useSleepTimer.getState().pauseAtPosition).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('ends, not freezes, when one write both tears the book down and stops playback', () => {
      // The book check inside `syncPlaybackFreeze` is only reached when the freeze state
      // MOVES on the same notification that changed the book - a book swap on its own
      // leaves the transport live and returns above it. That is exactly the shape of both
      // teardown paths in `store.ts`: `stop()` writes `nowPlaying: null` with the reset
      // snapshot in ONE `set`, and `playBook`'s failed-resume bail writes the new book
      // with `state: 'error'`. Without the check this freezes a dead book's timer and
      // leaves it standing (until some later tick notices), which is a timer the auto
      // sleep controller reads as "one already stands" in the meantime.
      const outcomes: SleepOutcome[] = [];
      const off = onSleepTimerEnded((outcome) => outcomes.push(outcome));
      useSleepTimer.getState().startDuration(30);
      jest.advanceTimersByTime(60_000);

      player.usePlayer.setState({
        nowPlaying: null,
        snapshot: { ...player.usePlayer.getState().snapshot, state: 'idle' },
      });
      off();

      const state = useSleepTimer.getState();
      expect(state.phase).toBe('idle');
      expect(state.frozenAt).toBeNull();
      expect(outcomes).toEqual([{ bookKey: 'srv-1:1:author/book-a.m4b', reason: 'expired' }]);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('ignores a shake once the book it was armed for has gone', async () => {
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(60_000);
      await flush();
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');

      // The book was stopped / finished during the grace: a shake must not toggle a
      // reset engine (the stall watchdog would surface a playback error 3s later).
      setBook(null);
      setPlayStateSilently('idle');
      useSleepTimer.getState().keepListening();
      expect(mockToggle).not.toHaveBeenCalled();
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');
    });
  });

  // --- firing against playback that is not running --------------------------

  describe('fire', () => {
    it('ends outright, with no grace window, when playback was already paused', async () => {
      // A chapter timer, because a DURATION timer can no longer get here: its countdown
      // freezes with playback (see the freeze tests above), so it cannot reach its target
      // against a paused book. A position target still can - the listener pauses by hand
      // and then scrubs, and the position crosses the boundary with nothing playing.
      setPosition(100);
      useSleepTimer.getState().startUntilPosition(1800, endOf('Chapter 3'));
      jest.advanceTimersByTime(1_000);
      setPlayStateSilently('paused');
      setPosition(1800); // scrubbed past the target while paused
      jest.advanceTimersByTime(1_000);
      await flush();

      // Nothing was stopped, so there is nothing to offer to undo: no grace, no
      // accelerometer, and no shake that could start the book playing out loud.
      expect(mockPause).not.toHaveBeenCalled();
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');
      expect(selectSleepExtendable(useSleepTimer.getState())).toBe(false);
      expect(useSleepTimer.getState().graceUntil).toBeNull();
      expect(quietestVolume()).toBe(1); // a chapter timer never dips the gain at all
      expect(jest.getTimerCount()).toBe(0);

      useSleepTimer.getState().keepListening();
      expect(mockToggle).not.toHaveBeenCalled();
    });

    it('still opens the grace window when it really did pause playback', async () => {
      useSleepTimer.getState().startDuration(1);
      setPlayStateSilently('playing');
      jest.advanceTimersByTime(60_000);
      await flush();
      expect(mockPause).toHaveBeenCalledTimes(1);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');
    });
  });

  // --- how the timer ended, said out loud ----------------------------------
  //
  // `onSleepTimerEnded` is the ONLY thing the auto sleep memory hears, and it is what
  // tells "the listener dismissed this" (stay out of the book for the session) from "it
  // ran its course" (a later play edge may arm a fresh one) - so every way out of a live
  // timer has to fire it, exactly once, with the right reason.

  describe('onSleepTimerEnded', () => {
    const BOOK_A_KEY = 'srv-1:1:author/book-a.m4b';
    let outcomes: SleepOutcome[];
    let unsubscribe: () => void;

    beforeEach(() => {
      outcomes = [];
      unsubscribe = onSleepTimerEnded((outcome) => outcomes.push(outcome));
    });

    afterEach(() => unsubscribe());

    it('says nothing while a timer is merely armed', () => {
      useSleepTimer.getState().startDuration(30);
      expect(outcomes).toEqual([]);
    });

    it('reports a cancellation, once', () => {
      useSleepTimer.getState().startDuration(30);
      useSleepTimer.getState().cancel();
      expect(outcomes).toEqual([{ bookKey: BOOK_A_KEY, reason: 'cancelled' }]);

      // Nothing is left to end, so a second cancel is silent rather than a phantom
      // ending the memory would fold in again.
      useSleepTimer.getState().cancel();
      expect(outcomes).toHaveLength(1);
    });

    it('reports the store as already idle when it fires', () => {
      // A subscriber may read the store (or arm a fresh timer) from the callback without
      // seeing the dead one.
      const phases: string[] = [];
      const off = onSleepTimerEnded(() => phases.push(useSleepTimer.getState().phase));
      useSleepTimer.getState().startDuration(30);
      useSleepTimer.getState().cancel();
      off();
      expect(phases).toEqual(['idle']);
    });

    it('reports a cancellation made INSIDE the grace window, not an expiry', async () => {
      // The precision the old inference lacked: it read `graceUntil !== null` as "it
      // fired", so dismissing the timer during the 30s grace was filed as an expiry -
      // and an expiry is the one outcome that lets the timer come back.
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(60_000);
      await flush();
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');

      useSleepTimer.getState().cancel();
      expect(outcomes).toEqual([{ bookKey: BOOK_A_KEY, reason: 'cancelled' }]);
    });

    it('reports an expiry when the grace window closes unshaken', async () => {
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(60_000);
      await flush();
      jest.advanceTimersByTime(GRACE_SECONDS * 1000);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');
      // Slept through: the one ending that says so (see 'falling asleep' below).
      expect(outcomes).toEqual([
        { bookKey: BOOK_A_KEY, reason: 'expired', fellAsleep: { stoppedAt: 0, touch: null } },
      ]);
    });

    it('reports an expiry when it fires against a book that was not playing', async () => {
      setPosition(100);
      useSleepTimer.getState().startUntilPosition(1800, endOf('Chapter 3'));
      setPlayState('paused');
      setPosition(1800); // scrubbed past the target while paused
      jest.advanceTimersByTime(1_000);
      await flush();
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');
      expect(outcomes).toEqual([{ bookKey: BOOK_A_KEY, reason: 'expired' }]);
    });

    it('reports an expiry, not a cancellation, when the book changes under it', () => {
      // Nobody dismissed this timer - the book it was counting down simply stopped being
      // the one playing. Filing it as a cancellation would lock auto sleep out of a book
      // for the night because the listener dipped into another one for five minutes.
      useSleepTimer.getState().startDuration(30);
      setBook(book('author/book-b.m4b', { chapters: [], total: 20_000 }));
      jest.advanceTimersByTime(1_000);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');
      expect(outcomes).toEqual([{ bookKey: BOOK_A_KEY, reason: 'expired' }]);
    });

    it('says nothing when a timer armed with nothing loaded ends', () => {
      // There is no book to attribute the ending to, and every consumer is per-book - so
      // a bogus key (or a keyless event they would have to filter) is worse than silence.
      setBook(null);
      useSleepTimer.getState().startDuration(30);
      expect(useSleepTimer.getState().bookKey).toBeNull();
      useSleepTimer.getState().cancel();
      expect(outcomes).toEqual([]);
    });

    it('stops delivering once unsubscribed', () => {
      unsubscribe();
      useSleepTimer.getState().startDuration(30);
      useSleepTimer.getState().cancel();
      expect(outcomes).toEqual([]);
    });
  });
  // --- falling asleep ----------------------------------------------------------
  //
  // The "Fell asleep" bookmark and the "You drifted off" prompt hang off ONE ending: the
  // timer fired and paused a playing book, and its grace window then closed with the
  // listener showing no sign of being awake. Every other way out must not claim it.

  describe('falling asleep', () => {
    const BOOK_A_KEY = 'srv-1:1:author/book-a.m4b';
    let outcomes: SleepOutcome[];
    let unsubscribe: () => void;

    beforeEach(() => {
      outcomes = [];
      unsubscribe = onSleepTimerEnded((outcome) => outcomes.push(outcome));
    });

    afterEach(() => unsubscribe());

    /** Arm a one-minute timer at `position`, let it fire, and land the pause. */
    async function fireAt(position: number) {
      setPosition(position);
      useSleepTimer.getState().startDuration(1);
      jest.advanceTimersByTime(60_000);
      await flush();
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('grace');
    }

    it('reports where it stopped and the last touch before the timer fired', async () => {
      setPosition(100);
      noteInteraction(); // the listener pressed something at 100s
      const touchedAt = Date.now();
      jest.advanceTimersByTime(5_000);
      await fireAt(400);
      jest.advanceTimersByTime(GRACE_SECONDS * 1000);
      expect(outcomes).toEqual([
        {
          bookKey: BOOK_A_KEY,
          reason: 'expired',
          fellAsleep: { stoppedAt: 400, touch: { at: touchedAt, position: 100 } },
        },
      ]);
    });

    it('is not a drift-off when the listener resumed by hand during the grace', async () => {
      await fireAt(400);
      jest.advanceTimersByTime(5_000); // well past the pause settling
      setPlayState('playing');
      jest.advanceTimersByTime(GRACE_SECONDS * 1000);
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');
      expect(outcomes).toEqual([{ bookKey: BOOK_A_KEY, reason: 'expired' }]);
    });

    it('ignores the engine still reporting playing while the pause lands', async () => {
      await fireAt(400);
      // A progress tick that left the engine before the pause did.
      setPlayState('playing');
      setPlayState('paused');
      jest.advanceTimersByTime(GRACE_SECONDS * 1000);
      expect(outcomes[0].fellAsleep).toEqual({ stoppedAt: 400, touch: null });
    });

    it('is not a drift-off when the listener scrubbed during the grace', async () => {
      await fireAt(400);
      setPosition(385); // back 15 seconds, still paused
      setPlayState('paused');
      jest.advanceTimersByTime(GRACE_SECONDS * 1000);
      expect(outcomes).toEqual([{ bookKey: BOOK_A_KEY, reason: 'expired' }]);
    });

    it('is not a drift-off when the listener cancels inside the grace', async () => {
      await fireAt(400);
      useSleepTimer.getState().cancel();
      expect(outcomes).toEqual([{ bookKey: BOOK_A_KEY, reason: 'cancelled' }]);
    });

    it('ends nothing when the listener keeps listening', async () => {
      await fireAt(400);
      useSleepTimer.getState().keepListening();
      expect(useSleepTimer.getState().phase).toBe('running');
      expect(outcomes).toEqual([]);
    });

    it('is not a drift-off when the timer fired against a paused book', async () => {
      setPosition(100);
      useSleepTimer.getState().startUntilPosition(1800, endOf('Chapter 3'));
      setPlayState('paused');
      setPosition(1800);
      jest.advanceTimersByTime(1_000);
      await flush();
      expect(outcomes).toEqual([{ bookKey: BOOK_A_KEY, reason: 'expired' }]);
    });

    it('is a drift-off when the morning play is what wakes the app', async () => {
      // iOS suspends the app once the timer has paused the audio: no tick closes the
      // grace overnight. The listener pressing play the next morning is the first thing
      // the timer hears - and it must read as the drift-off it was, not as a listener
      // who resumed inside the window.
      await fireAt(400);
      suspendFor(9 * 3600_000);
      setPlayState('playing');
      expect(selectSleepPhase(useSleepTimer.getState())).toBe('idle');
      expect(outcomes).toEqual([
        { bookKey: BOOK_A_KEY, reason: 'expired', fellAsleep: { stoppedAt: 400, touch: null } },
      ]);
    });

    it('records a keep-listening as a touch', async () => {
      await fireAt(400);
      useSleepTimer.getState().keepListening();
      expect(useSleepTimer.getState().phase).toBe('running');
      // The next fire reports the keep-listening as the last time they were awake.
      setPosition(1000);
      setPlayState('playing'); // the resume lands, which thaws the re-armed countdown
      jest.advanceTimersByTime(60_000);
      await flush();
      jest.advanceTimersByTime(GRACE_SECONDS * 1000);
      expect(outcomes[0].fellAsleep?.touch?.position).toBe(400);
    });
  });

  // --- several chapters ---------------------------------------------------------

  describe('stopping after several chapters', () => {
    it('re-arms ONE more chapter on keep listening, not the same number again', () => {
      setBook(
        book('author/book-a.m4b', {
          chapters: [
            chapter(0, 0, 600),
            chapter(1, 600, 600),
            chapter(2, 1200, 600),
            chapter(3, 1800, 600),
            chapter(4, 2400, 600),
          ],
          total: 3000,
        }),
      );
      setPosition(100);
      // "Or stop after 3 chapters": the end of chapter 3.
      useSleepTimer.getState().startUntilPosition(1800, {
        key: 'player.sleepTimer.afterChapters',
        params: { count: 3 },
      });
      setPosition(1780); // the last 20 seconds of the third chapter
      jest.advanceTimersByTime(1_000);
      expect(useSleepTimer.getState().phase).toBe('ending');

      useSleepTimer.getState().keepListening();
      const state = useSleepTimer.getState();
      expect(state.pauseAtPosition).toBe(2400); // the end of chapter 4, not of chapter 6
      expect(state.label).toEqual(endOf('Chapter 4'));
    });
  });
});
