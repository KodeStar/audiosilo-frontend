import { AppState } from 'react-native';

/**
 * Whether the app is in front, read two ways, and the edges between them.
 *
 * `AppState` covers every platform: on the web React Native's is the document's
 * visibility (`background` while the tab is hidden, `active` otherwise). Each reading
 * names the states that count as "not in front" instead of testing for `active`, so a
 * state that is neither (iOS reports `unknown` until the first real one arrives) reads
 * as in front, which is what the app does when it knows nothing.
 */

/** The app's state as `AppState` gives it (nothing before the first real one). */
type State = typeof AppState.currentState;

/** The app is not the one in use: in the background (a locked phone, another app in
 * front, a hidden tab), or `inactive` (iOS: the app switcher, Control Centre, a system
 * alert, a call coming in). What the periodic work slows down for. */
export function isAway(state: State = AppState.currentState): boolean {
  return state === 'background' || state === 'inactive';
}

/** Nothing of the app is on screen: in the background. Not `inactive`, where iOS still
 * shows the app behind what covers it. What the UI stops redrawing for. */
export function isOffScreen(state: State = AppState.currentState): boolean {
  return state === 'background';
}

/**
 * Call `fn` each time `reading` of the app's state changes, with its new value: the edge
 * only, so iOS's `inactive` on the way to `background` is one change of `isAway` and none
 * of `isOffScreen`. Returns the stop function.
 */
export function onAppStateEdge(
  reading: (state: State) => boolean,
  fn: (value: boolean) => void,
): () => void {
  let last = reading(AppState.currentState);
  // Undefined where there is no document (the web build's static render).
  const sub = AppState.addEventListener('change', (next) => {
    const value = reading(next);
    if (value === last) return;
    last = value;
    fn(value);
  }) as { remove(): void } | undefined;
  return () => sub?.remove();
}
