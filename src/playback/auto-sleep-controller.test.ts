import type { Chapter } from '@/api/types';
import type { MockNowPlaying, PlayerStoreMock } from '@/testing/player-store-mock';

// A faithful (but engine-free) stand-in for the player store: a real zustand store, so
// the controller's `subscribe(state, prev)` transition detection is exercised for real.
// Shared with the sleep timer's own suite - see `@/testing/player-store-mock`.
jest.mock('@/playback/store', () =>
  // `require` (not an import) because a jest.mock factory is hoisted above every import
  // and may not close over module-scope bindings.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/**
 * The controller keeps its anti-nag memory in MODULE state, which is the point of it -
 * "never again for this book" outlives any component. So each test gets a fresh module
 * registry (and with it a fresh memory, timer store, settings store and player double)
 * rather than sharing one session across the file.
 */
function load() {
  jest.resetModules();
  /* eslint-disable @typescript-eslint/no-require-imports */
  // The mocked module IS the double, so requiring it gets both halves in one.
  const player = require('@/playback/store') as unknown as PlayerStoreMock;
  const timer = require('@/playback/sleep-timer') as typeof import('@/playback/sleep-timer');
  const settings = require('@/stores/settings') as typeof import('@/stores/settings');
  const controller =
    require('@/playback/auto-sleep-controller') as typeof import('@/playback/auto-sleep-controller');
  const ticks = require('@/playback/engine-ticks') as typeof import('@/playback/engine-ticks');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    player,
    useSleepTimer: timer.useSleepTimer,
    GRACE_SECONDS: timer.GRACE_SECONDS,
    useSettings: settings.useSettings,
    startAutoSleep: controller.startAutoSleep,
    engineTick: ticks.engineTick,
  };
}

const BOOK: MockNowPlaying = {
  connectionId: 'srv-1',
  libraryId: 1,
  path: 'author/book.m4b',
  queue: { chapters: [], total: 3600 },
};
const OTHER_BOOK: MockNowPlaying = { ...BOOK, path: 'author/other.m4b' };

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

/** How long the two books below run for. Deliberately a real audiobook's length: the
 * whole point of the chapterless case is that "the end of the book" is not a sleep
 * timer, and a fixture only a few minutes long would hide that. */
const BOOK_SECONDS = 12 * 3600;

/** A properly chaptered book: half-hour chapters, so the first boundary worth arming is
 * 30 minutes in. */
const CHAPTERED: MockNowPlaying = {
  ...BOOK,
  path: 'author/chaptered.m4b',
  queue: { chapters: [chapter(0, 0, 1800), chapter(1, 1800, 1800)], total: BOOK_SECONDS },
};

/** The same book with no chapter marks at all - a single long file, which is how plenty
 * of real audiobooks arrive. */
const CHAPTERLESS: MockNowPlaying = {
  ...BOOK,
  path: 'author/chapterless.m4b',
  queue: { chapters: [], total: BOOK_SECONDS },
};

/** No automatic timer may be further away than this. It is not a tuning knob - it is the
 * line between "a sleep timer" and "the rest of the night", and the reason an automatic
 * end-of-chapter arm cannot fall back to the end of the book. */
const LONGEST_USEFUL_SECONDS = 60 * 60;

/** Just before the 22:00 window opens. */
const BEFORE_WINDOW = new Date(2026, 0, 15, 21, 59, 30);
/** Deep inside it. */
const IN_WINDOW = new Date(2026, 0, 15, 23, 0);

describe('auto sleep controller', () => {
  let ctx: ReturnType<typeof load>;
  let stop: (() => void) | null = null;

  const playing = () => ctx.player.setPlayState('playing');
  const paused = () => ctx.player.setPlayState('paused');
  const phase = () => ctx.useSleepTimer.getState().phase;
  const start = () => {
    stop = ctx.startAutoSleep();
  };
  /** Let the fire path's `pause().finally(restore)` microtasks settle. */
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  /**
   * Run an armed 30-minute timer all the way out: it fires (pausing playback) and its
   * grace window then closes unshaken. Leaves the book paused, exactly as a real night
   * would - the state a listener who wakes and presses play is in.
   */
  const runTimerOut = async () => {
    jest.advanceTimersByTime(30 * 60_000 + ctx.GRACE_SECONDS * 1000);
    await flush();
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BEFORE_WINDOW);
    ctx = load();
    ctx.player.patch({ nowPlaying: BOOK });
    ctx.useSettings.setState({
      autoSleepTimer: true,
      autoSleepFrom: '22:00',
      autoSleepUntil: '06:00',
      autoSleepType: '30',
    });
  });

  afterEach(() => {
    stop?.();
    stop = null;
    ctx.useSleepTimer.getState().cancel();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('arms on the play edge when playback starts inside the window', () => {
    jest.setSystemTime(IN_WINDOW);
    start();
    playing();
    expect(phase()).toBe('running');
    expect(ctx.useSleepTimer.getState().remaining).toBe(30 * 60);
  });

  it('does not arm for playback that starts outside the window', () => {
    start();
    playing();
    expect(phase()).toBe('idle');
  });

  it('arms mid-listen when the window opens during playback', () => {
    start();
    playing(); // 21:59:30 - too early, nothing armed
    expect(phase()).toBe('idle');

    // The poll runs a minute later, by which time the window has opened.
    jest.advanceTimersByTime(60_000);
    expect(phase()).toBe('running');
  });

  it('arms mid-listen from engine events alone when JS timers are paused (screen off)', () => {
    start();
    playing(); // 21:59:30 - too early, nothing armed
    // Android with the screen off: no timer fires, the engine's events (one a second)
    // arrive. The poll still checks once a minute, so the window opening is noticed.
    const screenOff = (seconds: number) => {
      for (let i = 0; i < seconds; i++) {
        jest.setSystemTime(Date.now() + 1_000);
        ctx.engineTick();
      }
    };
    screenOff(59);
    expect(phase()).toBe('idle'); // the window is open, but the minute's check is not due
    screenOff(1);
    expect(phase()).toBe('running');
  });

  it('adopts a book that was already playing when it started', () => {
    // A start mid-playback (the app's own bootstrap order is not guaranteed to beat the
    // engine) must take the same footing as a play edge rather than wait for the next
    // transition, which may never come.
    jest.setSystemTime(IN_WINDOW);
    playing();
    start();
    expect(phase()).toBe('running');
  });

  // --- the default type: end of chapter --------------------------------------

  /**
   * Put the world on the OUT-OF-THE-BOX setting - `autoSleepType` defaults to `chapter`,
   * so this is what every listener who never opens the timer-type picker gets - inside
   * the window, with `book` loaded and sitting at its start.
   */
  const chapterNight = (book: MockNowPlaying) => {
    ctx.useSettings.setState({ autoSleepType: 'chapter' });
    ctx.player.patch({ nowPlaying: book, bookPosition: 0 });
    jest.setSystemTime(IN_WINDOW);
  };

  it('arms an end-of-chapter timer, which is what the default setting asks for', () => {
    chapterNight(CHAPTERED);
    start();
    playing();

    expect(phase()).toBe('running');
    // Not merely "a timer": the chapter KIND, at the first boundary far enough away to
    // be worth arming. A duration timer here would be the wrong feature entirely.
    expect(ctx.useSleepTimer.getState().origin).toEqual({ kind: 'chapter' });
    expect(ctx.useSleepTimer.getState().pauseAtPosition).toBe(1800);
    expect(ctx.useSleepTimer.getState().label).toEqual({
      key: 'player.sleepTimer.endOf',
      params: { chapter: 'Chapter 1' },
    });
  });

  it('stops the book at the chapter boundary it armed', async () => {
    chapterNight(CHAPTERED);
    start();
    playing();
    expect(phase()).toBe('running');

    // The listener falls asleep and the book plays on to the end of chapter 1. A chapter
    // timer counts down by POSITION, so the position is what has to move.
    ctx.player.patch({ bookPosition: 1800 });
    jest.advanceTimersByTime(1000);
    await flush();

    expect(phase()).toBe('grace');
    expect(ctx.player.usePlayer.getState().snapshot.state).toBe('paused');
  });

  it('arms a timer that actually fires for a book with no chapters', async () => {
    // The default type asks for the end of a chapter, and this book has none. Falling
    // back to the end of the BOOK is not a sleep timer - it is twelve hours away, which
    // is indistinguishable from the feature being off for the listener who is asleep in
    // twenty minutes.
    chapterNight(CHAPTERLESS);
    start();
    playing();

    expect(phase()).toBe('running');
    const remaining = ctx.useSleepTimer.getState().remaining ?? Infinity;
    expect(remaining).toBeLessThanOrEqual(LONGEST_USEFUL_SECONDS);

    // And it is a real countdown, not just a small number: run it out (wall clock - the
    // fallback has no position to count down to) and the book is genuinely stopped.
    jest.advanceTimersByTime((remaining + 1) * 1000);
    await flush();
    expect(phase()).toBe('grace');
    expect(ctx.player.usePlayer.getState().snapshot.state).toBe('paused');
  });

  // --- one timer per continuous stretch of playback --------------------------

  it('never puts a second timer on top of one that is already standing', () => {
    jest.setSystemTime(IN_WINDOW);
    start();
    playing();
    expect(phase()).toBe('running');

    // Ten minutes in, the listener pauses and resumes - a fresh play EDGE, with this
    // book's timer still standing. The edge must not hand out a second one, which would
    // silently restart the countdown they are already on.
    jest.advanceTimersByTime(10 * 60_000);
    paused();
    playing();
    expect(ctx.useSleepTimer.getState().remaining).toBe(20 * 60);
    expect(ctx.useSleepTimer.getState().origin).toEqual({ kind: 'duration', minutes: 30 });
  });

  it('leaves a timer the user set themselves alone', () => {
    // Inside the window, so the ONLY thing standing between this book and an automatic
    // timer is the one the listener already set.
    jest.setSystemTime(IN_WINDOW);
    start();
    ctx.useSleepTimer.getState().startDuration(5); // a manual 5 minute timer
    playing();
    jest.advanceTimersByTime(60_000);
    // Untouched: still the user's own 5 minute timer, not an auto-armed one.
    expect(ctx.useSleepTimer.getState().origin).toEqual({ kind: 'duration', minutes: 5 });
  });

  // --- the anti-nag rules ---------------------------------------------------

  it('does not re-arm through the poll after the listener cancelled an auto timer', () => {
    start();
    playing();
    jest.advanceTimersByTime(60_000);
    expect(phase()).toBe('running');

    ctx.useSleepTimer.getState().cancel(); // the user cancels at 22:00
    jest.advanceTimersByTime(5 * 60_000); // deep in the window, and nothing re-arms
    expect(phase()).toBe('idle');
    // The poll stopped the moment this book's one timer was armed - there is nothing
    // left for it to decide until a different book plays.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not replace a timer the listener set and then cancelled themselves', () => {
    jest.setSystemTime(IN_WINDOW);
    start();
    ctx.useSleepTimer.getState().startDuration(45); // the listener's own timer
    playing();

    ctx.useSleepTimer.getState().cancel(); // ...and they cancel it
    jest.advanceTimersByTime(5 * 60_000);
    // The cancellation blocks the book whoever armed the timer, so the poll must not
    // hand out an automatic replacement a minute later.
    expect(phase()).toBe('idle');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not give a book a second automatic timer after switching away and back', () => {
    jest.setSystemTime(IN_WINDOW);
    start();
    playing(); // book A gets its automatic timer
    expect(phase()).toBe('running');
    ctx.useSleepTimer.getState().cancel(); // which the listener cancels

    // Book B, then straight back to A. The memory covers the whole session, so it
    // cannot be one slot keyed on the current book: A -> B -> A used to wipe A's
    // record and re-arm on the very book the listener had cancelled a timer for.
    paused();
    ctx.player.usePlayer.setState({ nowPlaying: OTHER_BOOK });
    playing();
    expect(phase()).toBe('running');
    ctx.useSleepTimer.getState().cancel();
    paused();
    ctx.player.usePlayer.setState({ nowPlaying: BOOK });
    playing();

    jest.advanceTimersByTime(5 * 60_000); // neither the play edge nor the poll re-arms
    expect(phase()).toBe('idle');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps a cancelled book blocked across a stop and restart', () => {
    // The memory is MODULE state, not a component's ref: "never again for this book"
    // is a promise about the session, and stopping the controller is not the listener
    // changing their mind.
    jest.setSystemTime(IN_WINDOW);
    start();
    playing();
    expect(phase()).toBe('running');
    ctx.useSleepTimer.getState().cancel();

    stop?.();
    stop = null;
    paused();
    start();
    playing();
    expect(phase()).toBe('idle');
  });

  it('gives a different book its own chance', () => {
    start();
    playing();
    jest.advanceTimersByTime(60_000);
    ctx.useSleepTimer.getState().cancel();

    ctx.player.usePlayer.setState({ nowPlaying: OTHER_BOOK });
    paused();
    playing();
    expect(phase()).toBe('running');
  });

  // --- a timer that ran its course does NOT retire the book ------------------

  it('arms a fresh timer on a later play edge once the previous one ran its course', async () => {
    jest.setSystemTime(IN_WINDOW);
    start();
    playing();
    expect(phase()).toBe('running');

    await runTimerOut();
    expect(phase()).toBe('idle');
    expect(ctx.player.usePlayer.getState().snapshot.state).toBe('paused'); // the timer stopped it

    // 23:30 and the listener is awake again. Under the old "one timer per book per
    // session" rule they got nothing at all for the rest of the night; pressing play
    // inside the window is them saying they are still listening.
    playing();
    expect(phase()).toBe('running');
    expect(ctx.useSleepTimer.getState().remaining).toBe(30 * 60);
  });

  it('does not re-arm itself when a timer fires - only a play edge can', async () => {
    jest.setSystemTime(IN_WINDOW);
    start();
    playing();

    // Fire, grace, and then ten minutes of the app just sitting there. The fire pauses
    // playback, so no play edge follows on its own - which is what makes the
    // fire -> re-arm -> fire loop unreachable rather than merely unlikely.
    await runTimerOut();
    jest.advanceTimersByTime(10 * 60_000);
    expect(phase()).toBe('idle');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cannot slip a fresh timer into the grace window', async () => {
    jest.setSystemTime(IN_WINDOW);
    start();
    playing();
    jest.advanceTimersByTime(30 * 60_000); // fires, opening the grace window
    await flush();
    expect(phase()).toBe('grace');

    // The listener resumes by hand rather than shaking. A timer IS still standing (the
    // grace is the window in which a shake undoes the pause), so nothing may arm on top
    // of it - the play edge included.
    playing();
    jest.advanceTimersByTime((ctx.GRACE_SECONDS - 1) * 1000);
    expect(phase()).toBe('grace');
  });

  it('stays out of a book the listener cancelled during the grace window', async () => {
    jest.setSystemTime(IN_WINDOW);
    start();
    playing();
    jest.advanceTimersByTime(30 * 60_000); // fires, opening the grace window
    await flush();
    expect(phase()).toBe('grace');

    // Dismissed from the grace window - the case the old "which field is set?" guess
    // misfiled as an expiry, which would let the timer come back.
    ctx.useSleepTimer.getState().cancel();
    playing();
    jest.advanceTimersByTime(5 * 60_000);
    expect(phase()).toBe('idle');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('protects a listener who resumed by hand during the grace window', async () => {
    jest.setSystemTime(IN_WINDOW);
    start();
    playing();
    jest.advanceTimersByTime(30 * 60_000); // fires, pausing playback
    await flush();
    expect(phase()).toBe('grace');

    playing(); // they press play during the grace, rather than shaking
    jest.advanceTimersByTime(ctx.GRACE_SECONDS * 1000); // ...and the grace closes anyway
    expect(phase()).toBe('idle');

    // The one case with no play edge left to come: they are already playing, with
    // nothing armed. The poll is the only thing that can cover the rest of the night.
    jest.advanceTimersByTime(60_000);
    expect(phase()).toBe('running');
  });

  it('re-arms for a book whose timer was dropped when another book took over', () => {
    jest.setSystemTime(IN_WINDOW);
    start();
    playing(); // book A gets its automatic timer
    expect(phase()).toBe('running');

    // Book B takes over mid-play. A's timer was nobody's to dismiss - the book it was
    // counting down simply stopped playing - so it ends as an expiry and retires neither
    // book. B is now playing with nothing armed and no play edge coming, so the poll arms.
    ctx.player.usePlayer.setState({ nowPlaying: OTHER_BOOK });
    jest.advanceTimersByTime(1_000); // the timer's own tick notices the swap
    expect(phase()).toBe('idle');
    jest.advanceTimersByTime(60_000);
    expect(phase()).toBe('running');
    ctx.useSleepTimer.getState().cancel();

    // And A, whose timer the listener never cancelled, still gets one when it returns.
    paused();
    ctx.player.usePlayer.setState({ nowPlaying: BOOK });
    playing();
    expect(phase()).toBe('running');
  });

  it('lets an auto timer follow one the listener armed themselves and let run out', async () => {
    jest.setSystemTime(IN_WINDOW);
    start();
    ctx.useSleepTimer.getState().startDuration(30); // their own timer
    playing();
    await runTimerOut();

    playing();
    expect(phase()).toBe('running');
  });

  // --- what it costs while it is switched off --------------------------------

  it('never starts the poll while the feature is switched off', () => {
    ctx.useSettings.setState({ autoSleepTimer: false });
    start();
    playing();
    // Ten minutes of listening straight through the 22:00 window opening: the setting
    // defaults to OFF, so a session that never enables it must cost no wakeups at all.
    jest.advanceTimersByTime(10 * 60_000);
    expect(phase()).toBe('idle');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not subscribe to the player store while the feature is off', () => {
    // The player store is written several times a second while a book plays, and the
    // setting defaults to OFF - so the subscription follows the setting rather than the
    // process. (Nothing else is subscribed here: the sleep timer only watches the store
    // while a countdown is live.)
    ctx.useSettings.setState({ autoSleepTimer: false });
    start();
    expect(ctx.player.subscriberCount()).toBe(0);

    ctx.useSettings.setState({ autoSleepTimer: true });
    expect(ctx.player.subscriberCount()).toBe(1);

    ctx.useSettings.setState({ autoSleepTimer: false });
    expect(ctx.player.subscriberCount()).toBe(0);
  });

  it('picks up the feature being switched on mid-session', () => {
    ctx.useSettings.setState({ autoSleepTimer: false });
    start();
    playing();
    jest.setSystemTime(IN_WINDOW);

    ctx.useSettings.setState({ autoSleepTimer: true });
    expect(phase()).toBe('running');
  });

  it('drops the poll when the feature is switched off mid-session', () => {
    start();
    playing(); // outside the window, so the poll is running and waiting for 22:00

    ctx.useSettings.setState({ autoSleepTimer: false });
    jest.advanceTimersByTime(10 * 60_000);
    expect(phase()).toBe('idle');
    expect(jest.getTimerCount()).toBe(0);
  });

  // --- teardown --------------------------------------------------------------

  it('stops polling when playback stops', () => {
    start();
    playing();
    paused(); // still before the window opened
    jest.advanceTimersByTime(10 * 60_000);
    expect(phase()).toBe('idle');
    // Nothing of ours is left ticking.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('gives a second controller its own watch, and its own teardown', () => {
    // Nothing starts two of these today, and the point of the test is that nothing CAN
    // regress into a half-started one: with the poll and the player watch held in module
    // state, the second controller saw the first one's subscription as its own, installed
    // nothing, and went permanently blind to play edges the moment the first was torn
    // down - silently, with a healthy-looking store.
    jest.setSystemTime(IN_WINDOW);
    start();
    const stopSecond = ctx.startAutoSleep();
    try {
      expect(ctx.player.subscriberCount()).toBe(2);

      stop?.(); // the first one goes away
      stop = null;
      expect(ctx.player.subscriberCount()).toBe(1);

      // The survivor still sees the play edge, and still arms.
      playing();
      expect(phase()).toBe('running');
      // Back to nothing armed, so the only subscription left is the survivor's own (a
      // live timer watches the store too, to freeze its countdown).
      ctx.useSleepTimer.getState().cancel();
      expect(ctx.player.subscriberCount()).toBe(1);
    } finally {
      stopSecond();
    }
    expect(ctx.player.subscriberCount()).toBe(0);
  });

  it('can be torn down twice', () => {
    // `_layout.tsx` hands the teardown to React, and StrictMode's mount/cleanup/mount is
    // not the only way it can be called more than once.
    const teardown = ctx.startAutoSleep();
    teardown();
    expect(() => teardown()).not.toThrow();

    playing();
    expect(phase()).toBe('idle');
    expect(ctx.player.subscriberCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves nothing subscribed or ticking when it is stopped', () => {
    start();
    playing();
    stop?.();
    stop = null;
    jest.advanceTimersByTime(10 * 60_000);
    expect(phase()).toBe('idle');
    expect(jest.getTimerCount()).toBe(0);
    expect(ctx.player.subscriberCount()).toBe(0);
  });
});
