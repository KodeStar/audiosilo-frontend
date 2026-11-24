import { useEffect, useReducer } from 'react';
import { Platform } from 'react-native';

/**
 * The reader's top bar in immersive mode (fe#246): it hides once the reader has rested on the
 * page `CHROME_HIDE_MS` without touching it, or at the first page turn, whichever comes first.
 * A tap in the middle of the page shows it again (and hides it, when it shows), and it hides
 * again after the same wait. It never hides while it cannot (`mayHide`): auto-hide turned off,
 * a screen reader on, no book on the page (opening, or a failure said), or a menu or sheet
 * from it open.
 *
 * In the apps, until a centre tap has reached this run of the app (`centreTapArrived`), a
 * page turn shows the bar for the wait instead (`turnShows`): the centre tap is a click in
 * the reader's WebView, and a WebView that never delivered one would otherwise leave the
 * reader with no way back to the bar. The first centre tap turns that off for good.
 *
 * The rules are pure (`mayHide`, `nextChrome`, `settleChrome`, `chromeTimerRuns`) and
 * `useReaderChrome` runs them with the timer.
 */

/** How long the top bar stays after it shows, or after the last touch on it. */
export const CHROME_HIDE_MS = 4000;

/** `hidden`: hidden by a wait or a page turn. `epoch` counts each show and each touch on the
 * bar, so the wait starts again from it. */
export type ChromeState = { hidden: boolean; epoch: number };

export const CHROME_START: ChromeState = { hidden: false, epoch: 0 };

/** What keeps the top bar on screen. */
export type ChromeHold = {
  /** The setting: hide the top bar while reading. */
  autoHide: boolean;
  /** VoiceOver or TalkBack is on. */
  screenReader: boolean;
  /** The book shows (opened, no failure said over it). */
  reading: boolean;
  /** A menu or sheet from the top bar is open. */
  menuOpen: boolean;
};

/** `timeout`: the wait ran out; `pageTurn`: the reader turned a page (not the narration);
 * `centreTap`: a tap in the middle of the page; `touch`: a press on the bar itself. */
export type ChromeEvent = 'timeout' | 'pageTurn' | 'centreTap' | 'touch';

/** Whether the top bar may hide now. */
export function mayHide(hold: ChromeHold): boolean {
  return hold.autoHide && !hold.screenReader && hold.reading && !hold.menuOpen;
}

const show = (state: ChromeState): ChromeState => ({ hidden: false, epoch: state.epoch + 1 });

/** The bar after `event`, where `canHide` is `mayHide` of what holds it now and `turnShows`
 * whether a page turn shows the bar (with a fresh wait) rather than hiding it. */
export function nextChrome(
  state: ChromeState,
  event: ChromeEvent,
  canHide: boolean,
  turnShows = false,
): ChromeState {
  const hide = canHide && !state.hidden ? { ...state, hidden: true } : state;
  switch (event) {
    case 'timeout':
      return hide;
    case 'pageTurn':
      return turnShows && canHide ? show(state) : hide;
    case 'centreTap':
      return state.hidden ? show(state) : hide;
    case 'touch':
      return show(state);
  }
}

/** A bar hidden while something now holds it (a screen reader turned on, the setting turned
 * off, a failure said) shows, with a fresh wait for when the hold ends. */
export function settleChrome(state: ChromeState, canHide: boolean): ChromeState {
  return state.hidden && !canHide ? show(state) : state;
}

/** Whether the wait to hide the bar runs: it shows and may hide. */
export function chromeTimerRuns(state: ChromeState, canHide: boolean): boolean {
  return !state.hidden && canHide;
}

/** Whether a centre tap has reached this run of the app. */
let centreTapSeen = false;

/** A centre tap arrived: the reader's taps reach the app, so a page turn may hide the bar. */
export function centreTapArrived(): void {
  centreTapSeen = true;
}

/** For tests: no centre tap has arrived yet. */
export function resetCentreTapForTests(): void {
  centreTapSeen = false;
}

/** Whether a page turn shows the bar: in the apps, until a centre tap has arrived. */
export function turnShows(): boolean {
  return Platform.OS !== 'web' && !centreTapSeen;
}

type ChromeAction = { event: ChromeEvent; canHide: boolean; turnShows?: boolean };
const reduceChrome = (state: ChromeState, action: ChromeAction) =>
  nextChrome(state, action.event, action.canHide, action.turnShows);

/**
 * The top bar's state on the reader screen (`nextChrome` with its timer): whether it shows,
 * and the events that move it.
 */
export function useReaderChrome(hold: ChromeHold): {
  shown: boolean;
  /** The reader turned a page. */
  pageTurned: () => void;
  /** A tap in the middle of the page. */
  centreTapped: () => void;
  /** A press on the bar: it stays, and its wait starts again. */
  touched: () => void;
} {
  const canHide = mayHide(hold);
  const [state, dispatch] = useReducer(reduceChrome, CHROME_START);
  // Settled while rendering: a hold that came while hidden shows the bar at once.
  if (settleChrome(state, canHide) !== state) dispatch({ event: 'touch', canHide });
  const runs = chromeTimerRuns(state, canHide);
  const { epoch } = state;
  useEffect(() => {
    if (!runs) return;
    // It runs only while the bar may hide; a hold that came meanwhile stopped it.
    const id = setTimeout(() => dispatch({ event: 'timeout', canHide: true }), CHROME_HIDE_MS);
    return () => clearTimeout(id);
    // The wait starts again at each show or touch (`epoch`).
  }, [runs, epoch]);
  return {
    // A hold that came while hidden was settled above, before this render commits.
    shown: !state.hidden,
    pageTurned: () => dispatch({ event: 'pageTurn', canHide, turnShows: turnShows() }),
    centreTapped: () => {
      centreTapArrived();
      dispatch({ event: 'centreTap', canHide });
    },
    touched: () => dispatch({ event: 'touch', canHide }),
  };
}
