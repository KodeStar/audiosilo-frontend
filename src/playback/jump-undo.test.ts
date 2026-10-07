import type { MockNowPlaying, PlayerStoreMock } from '@/testing/player-store-mock';

// A real zustand stand-in for the player store (see `@/testing/player-store-mock`), so
// the controller's subscription sees writes exactly as it would in production.
jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import {
  COALESCE_MS,
  isJump,
  JUMP_THRESHOLD_S,
  SETTLE_MS,
  SUSPENSION_GAP_MS,
  UNDO_WINDOW_MS,
} from './jump-undo';
/* eslint-enable import/first */

describe('isJump', () => {
  const playing = (position: number) => ({ position, playing: true });
  const paused = (position: number) => ({ position, playing: false });

  it('is not natural playback, at any speed', () => {
    expect(isJump(playing(100), playing(100.25), 0.25, 1)).toBe(false);
    expect(isJump(playing(100), playing(100.5), 0.25, 2)).toBe(false);
    // A minute and a half of listening between two samples (a slow tick stream).
    expect(isJump(playing(100), playing(190), 90, 1)).toBe(false);
  });

  it('is a scrub of more than a minute, either way', () => {
    expect(isJump(playing(100), playing(400), 0.25, 1)).toBe(true);
    expect(isJump(playing(400), playing(100), 0.25, 1)).toBe(true);
    expect(isJump(paused(100), paused(1000), 30, 1)).toBe(true);
    expect(isJump(paused(1000), paused(100), 30, 1)).toBe(true);
  });

  it('is not a seek of a minute or less', () => {
    expect(isJump(playing(100), playing(160), 0, 1)).toBe(false);
    expect(isJump(playing(100), playing(40), 0, 1)).toBe(false);
    expect(isJump(paused(100), paused(160), 600, 1)).toBe(false);
    expect(isJump(paused(100), paused(161), 600, 1)).toBe(true);
    expect(isJump(playing(100), playing(39), 0, 1)).toBe(true);
  });

  it('allows anything up to elapsed x rate while playing, also over a long suspension', () => {
    // An hour suspended in the background at 1.5x: 5400 s of book went by.
    expect(isJump(playing(1000), playing(6400), 3600, 1.5)).toBe(false);
    // ...or paused somewhere in that hour (less than the allowance).
    expect(isJump(playing(1000), paused(2000), 3600, 1.5)).toBe(false);
    // More than playback could have covered is still a jump.
    expect(isJump(playing(1000), playing(6461), 3600, 1.5)).toBe(true);
  });

  it('allows nothing while paused, unless JS was not running', () => {
    expect(isJump(paused(1000), playing(2800), 3600, 1)).toBe(true);
    expect(isJump(paused(1000), playing(2800), 3600, 1, true)).toBe(false);
    // Backward is never natural, observed or not.
    expect(isJump(paused(1000), paused(500), 3600, 1, true)).toBe(true);
  });

  it('treats a bad rate as 1x and a negative elapsed as none', () => {
    expect(isJump(playing(0), playing(100), 50, 0)).toBe(false);
    expect(isJump(playing(0), playing(100), -50, 1)).toBe(true);
  });
});

const BOOK: MockNowPlaying = {
  connectionId: 'srv',
  libraryId: 1,
  path: 'a/book',
  queue: { chapters: [], total: 36_000 },
};
const OTHER: MockNowPlaying = { ...BOOK, path: 'a/other' };

/** A fresh registry per test: the module keeps its undo and landing in module state. */
function load() {
  jest.resetModules();
  /* eslint-disable @typescript-eslint/no-require-imports */
  const player = require('@/playback/store') as unknown as PlayerStoreMock;
  const undo = require('./jump-undo') as typeof import('./jump-undo');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const seekBook = jest.fn((position: number) => {
    // The engine lands where it was told, a moment later.
    void position;
    return Promise.resolve();
  });
  player.usePlayer.setState({ seekBook } as never);

  /** An engine report: a new snapshot at a whole-book position. */
  const report = (state: string, position: number) =>
    player.usePlayer.setState({
      bookPosition: position,
      snapshot: { ...player.usePlayer.getState().snapshot, state, position },
    });
  /** Load `book` the way `playBook` does: the book changes first, the snapshot later. */
  const loadBook = (book: MockNowPlaying | null) => player.usePlayer.setState({ nowPlaying: book });
  const settled = () => jest.advanceTimersByTime(SETTLE_MS + 1);
  const jump = () => undo.useJumpUndo.getState().jump;
  return { player, undo, seekBook, report, loadBook, settled, jump };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-07T21:00:00Z') });
});
afterEach(() => {
  jest.useRealTimers();
});

/** A book loaded, resumed at `at` and playing past the settle window. */
function playingAt(at: number) {
  const env = load();
  const stop = env.undo.startJumpUndo();
  env.loadBook(BOOK);
  env.report('loading', 0);
  env.report('playing', at);
  env.settled();
  env.report('playing', at + SETTLE_MS / 1000);
  return { ...env, stop };
}

describe('startJumpUndo', () => {
  it('records where you were after a scrub of more than a minute', () => {
    const { report, jump, stop } = playingAt(1000);
    report('playing', 4000);
    expect(jump()).toMatchObject({ from: 1003, bookKey: 'srv:1:a/book' });
    expect(jump()!.until).toBe(Date.now() + UNDO_WINDOW_MS);
    stop();
  });

  it('records a seek that arrives through buffering (scrub while streaming)', () => {
    const { report, jump, stop } = playingAt(1000);
    report('loading', 4000);
    jest.advanceTimersByTime(2000);
    report('playing', 4000.2);
    expect(jump()?.from).toBe(1003);
    stop();
  });

  it('records an Android media-session next chapter (clip transition, then a rebuffer)', () => {
    // Media3 seekToNext moves to the next chapter clip: onPositionDiscontinuity reports
    // the new file-relative position while the state is still playing, then the clip
    // buffers and plays on.
    const { report, jump, stop } = playingAt(3700);
    jest.advanceTimersByTime(400);
    report('playing', 3960);
    report('loading', 3960);
    jest.advanceTimersByTime(800);
    report('playing', 3960.3);
    expect(jump()?.from).toBe(3703);
    stop();
  });

  it('does not record a next chapter that lands a minute or less ahead', () => {
    // A 60 s chapter (The Short Light): no next chapter is ever more than a minute away.
    const { report, jump, stop } = playingAt(130);
    report('playing', 180);
    report('loading', 180);
    report('playing', 180.2);
    expect(jump()).toBeNull();
    stop();
  });

  it('records a jump made while paused, however long after (a lock-screen seek)', () => {
    const { report, jump, stop } = playingAt(1000);
    report('paused', 1003.5);
    jest.advanceTimersByTime(10 * 60_000); // JS alive: the heartbeat keeps beating
    report('paused', 1003.5 + 600);
    expect(jump()?.from).toBe(1003.5);
    stop();
  });

  it('ignores seeks of a minute or less, and natural playback', () => {
    const { report, jump, stop } = playingAt(1000);
    report('playing', 1050);
    report('playing', 1000);
    let at = 1000;
    for (let i = 0; i < 40; i++) {
      jest.advanceTimersByTime(250);
      at += 0.25;
      report('playing', at);
    }
    expect(jump()).toBeNull();
    stop();
  });

  it('ignores loading and resuming a book (0, then the resume point)', () => {
    const { loadBook, report, jump, undo } = load();
    const stop = undo.startJumpUndo();
    // The previous engine state is still in the snapshot when the book changes.
    report('playing', 5);
    loadBook(BOOK);
    report('loading', 0);
    report('playing', 0);
    report('playing', 7200);
    expect(jump()).toBeNull();
    stop();
  });

  it('ignores a book change, wherever each book is', () => {
    const { loadBook, report, jump, settled, stop } = playingAt(1000);
    loadBook(OTHER);
    report('loading', 1003);
    report('playing', 20_000);
    settled();
    report('playing', 20_003);
    expect(jump()).toBeNull();
    stop();
  });

  it('drops the undo when the book changes', () => {
    const { loadBook, report, jump, stop } = playingAt(1000);
    report('playing', 4000);
    expect(jump()).not.toBeNull();
    loadBook(OTHER);
    expect(jump()).toBeNull();
    stop();
  });

  it('ignores the download hot-swap (same book, same place)', () => {
    const { player, report, jump, stop } = playingAt(1000);
    player.usePlayer.setState({ nowPlaying: { ...BOOK } });
    report('playing', 1003.25);
    expect(jump()).toBeNull();
    stop();
  });

  it('ignores a retry that reloads where it was', () => {
    const { report, jump, stop } = playingAt(1000);
    report('error', 1003);
    jest.advanceTimersByTime(20_000);
    report('loading', 0);
    report('loading', 1003);
    report('playing', 1003);
    expect(jump()).toBeNull();
    stop();
  });

  it('ignores the app returning from a long suspension while playing', () => {
    const { report, jump, stop } = playingAt(1000);
    // JS suspended for an hour: no timers ran, the clock moved on.
    jest.setSystemTime(Date.now() + 3600_000);
    report('playing', 1003 + 3600);
    expect(jump()).toBeNull();
    stop();
  });

  it('ignores a lock-screen play while JS was suspended on a paused book', () => {
    const { report, jump, stop } = playingAt(1000);
    report('paused', 1003);
    jest.setSystemTime(Date.now() + SUSPENSION_GAP_MS + 1800_000);
    report('playing', 1003 + 1800);
    expect(jump()).toBeNull();
    stop();
  });

  it('still records a backward jump made during a suspension', () => {
    const { report, jump, stop } = playingAt(1000);
    jest.setSystemTime(Date.now() + 600_000);
    report('playing', 100);
    expect(jump()?.from).toBe(1003);
    stop();
  });

  it('does not record a seek inside the settle window after a load', () => {
    const { loadBook, report, jump, undo } = load();
    const stop = undo.startJumpUndo();
    loadBook(BOOK);
    report('playing', 1000);
    jest.advanceTimersByTime(1000);
    report('playing', 5000);
    expect(jump()).toBeNull();
    stop();
  });

  it('does nothing for a book without a whole-book timeline', () => {
    const { loadBook, report, jump, settled, undo } = load();
    const stop = undo.startJumpUndo();
    loadBook({ ...BOOK, queue: { chapters: [], total: 0 } });
    report('playing', 10);
    settled();
    report('playing', 2000);
    expect(jump()).toBeNull();
    stop();
  });

  it('lives ten seconds', () => {
    const { report, jump, stop } = playingAt(1000);
    report('playing', 4000);
    jest.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(jump()).not.toBeNull();
    jest.advanceTimersByTime(1);
    expect(jump()).toBeNull();
    stop();
  });

  it('is replaced by a new jump, with a fresh ten seconds', () => {
    const { report, jump, stop } = playingAt(1000);
    report('playing', 4000);
    jest.advanceTimersByTime(5000);
    report('playing', 9000);
    expect(jump()?.from).toBe(4000);
    jest.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(jump()).not.toBeNull();
    stop();
  });

  it('keeps the first "from" when a jump lands in two steps', () => {
    const { report, jump, stop } = playingAt(1000);
    report('playing', 4000);
    jest.advanceTimersByTime(COALESCE_MS - 500);
    report('playing', 7000);
    expect(jump()?.from).toBe(1003);
    stop();
  });

  it('clears when a jump lands back where the chip would go', () => {
    const { report, jump, stop } = playingAt(1000);
    report('playing', 4000);
    jest.advanceTimersByTime(500);
    report('playing', 1010);
    expect(jump()).toBeNull();
    stop();
  });

  it('undo seeks back without making a new undo', () => {
    const { report, jump, undo, seekBook, stop } = playingAt(1000);
    report('playing', 4000);
    jest.advanceTimersByTime(2000);
    expect(undo.undoJump()).toBe(1003);
    expect(seekBook).toHaveBeenCalledWith(1003);
    expect(jump()).toBeNull();
    // The engine lands there: the undo's own jump is not recorded.
    report('playing', 1003.1);
    expect(jump()).toBeNull();
    // ...but the next real jump is.
    jest.advanceTimersByTime(2000);
    report('playing', 9000);
    expect(jump()?.from).toBe(1003.1);
    stop();
  });

  it('has nothing to undo for another book or after it expired', () => {
    const { report, undo, seekBook, stop } = playingAt(1000);
    expect(undo.undoJump()).toBeNull();
    report('playing', 4000);
    jest.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(undo.undoJump()).toBeNull();
    expect(seekBook).not.toHaveBeenCalled();
    stop();
  });

  it('selects the undo only for its own book', () => {
    const { report, undo, stop } = playingAt(1000);
    report('playing', 4000);
    const state = undo.useJumpUndo.getState();
    expect(undo.selectUndoFor('srv:1:a/book')(state)?.from).toBe(1003);
    expect(undo.selectUndoFor('srv:1:a/other')(state)).toBeNull();
    expect(undo.selectUndoFor(null)(state)).toBeNull();
    stop();
  });

  it('stops watching when torn down', () => {
    const { report, jump, stop } = playingAt(1000);
    stop();
    report('playing', 4000);
    expect(jump()).toBeNull();
  });

  it('uses the threshold strictly', () => {
    const { report, jump, stop } = playingAt(1000);
    report('playing', 1003 + JUMP_THRESHOLD_S);
    expect(jump()).toBeNull();
    stop();
  });
});

describe('the heartbeat runs only away from the foreground', () => {
  /** A fresh registry whose AppState reads `state` and hands its listener back. */
  function withAppState(state: string) {
    const env = load();
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const { AppState } = require('react-native') as typeof import('react-native');
    let current = state;
    Object.defineProperty(AppState, 'currentState', { get: () => current, configurable: true });
    let onChange: (s: string) => void = () => {};
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _: string,
      l: (s: string) => void,
    ) => {
      onChange = l;
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);
    const stop = env.undo.startJumpUndo();
    env.loadBook(BOOK);
    env.report('loading', 0);
    env.report('playing', 1000);
    env.settled();
    env.report('playing', 1003);
    const go = (s: string) => {
      current = s;
      onChange(s);
    };
    return { ...env, stop, go };
  }
  afterEach(() => jest.restoreAllMocks());

  it('wakes nothing in the foreground, where JS always runs, and still sees a paused seek', () => {
    const { report, jump, stop } = withAppState('active');
    expect(jest.getTimerCount()).toBe(0);
    report('paused', 1003);
    jest.setSystemTime(Date.now() + 10 * 60_000); // no heartbeat ran, none was needed
    report('paused', 1003 + 600);
    expect(jump()?.from).toBe(1003);
    stop();
  });

  it('beats in the background, and a stall there reads as a suspension on return', () => {
    const { report, jump, stop, go } = withAppState('active');
    report('paused', 1003);
    go('background');
    expect(jest.getTimerCount()).toBe(1);
    // iOS suspends JS: no timer runs while the clock moves on.
    jest.setSystemTime(Date.now() + SUSPENSION_GAP_MS + 1800_000);
    go('active');
    expect(jest.getTimerCount()).toBe(0);
    // Played from the lock screen meanwhile: not a jump.
    report('playing', 1003 + 1800);
    expect(jump()).toBeNull();
    stop();
  });

  it('keeps seeing a lock-screen seek in the background while JS runs', () => {
    const { report, jump, stop, go } = withAppState('active');
    report('paused', 1003);
    go('background');
    jest.advanceTimersByTime(10 * 60_000); // JS alive: the heartbeat keeps beating
    report('paused', 1003 + 600);
    expect(jump()?.from).toBe(1003);
    stop();
  });
});
