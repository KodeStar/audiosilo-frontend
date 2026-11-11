import { type StoreApi, type UseBoundStore, useStore } from 'zustand';

import { isOffScreen, onAppStateEdge } from './app-activity';

/**
 * A store's React hook that does not redraw for a TICK while the app is off screen.
 *
 * A store that moves about once a second while a book plays (the player's place, the sleep
 * timer's countdown) re-renders every mounted component that reads it, and a mounted
 * screen stays mounted with the phone locked or the tab hidden: the full player left open
 * redrew its seek bar, its times and its chapter list every second for nobody (perf P4).
 *
 * The hook this returns reads what is SHOWN, a second view of the store, instead of its
 * live state. In front the two are the same object. Off screen (`isOffScreen`: the app in
 * the background, a hidden tab; not iOS's `inactive`, where the app is still seen behind
 * what covers it) a change that is only a tick of `field` is not shown: no listener runs,
 * no selector runs, nothing renders. Any other change is shown whole and at once, `field`
 * included, so everything a component DOES with the store still happens in the background
 * (the end of a book starting the next one, a pause, another book loading): only the
 * redraw of a moving number waits. Coming back on screen shows the live state at once.
 *
 * A tick is: `field` changed in a way `isTick` accepts, and no other field changed.
 *
 * Only the hook reads the shown state. `getState`, `setState` and `subscribe` on what this
 * returns are the store's own, live as ever: the store's logic and every reader outside
 * React (the car, the widgets, the lock screen's native side, the sleep timer) never see a
 * held value. So a rule that must run in the background reads `getState()` or subscribes;
 * it never depends on a component re-rendering for the place.
 */
export function quietOffScreen<S extends object, K extends keyof S>(
  store: StoreApi<S>,
  field: K,
  isTick: (shown: S[K], live: S[K]) => boolean,
): UseBoundStore<StoreApi<S>> {
  let shown = store.getState();
  const listeners = new Set<(state: S, prev: S) => void>();
  const show = (next: S) => {
    if (next === shown) return;
    const prev = shown;
    shown = next;
    for (const listener of [...listeners]) listener(next, prev);
  };
  const onlyATick = (live: S) => {
    if (!isTick(shown[field], live[field])) return false;
    for (const key of Object.keys(live) as (keyof S)[]) {
      if (key !== field && live[key] !== shown[key]) return false;
    }
    return true;
  };
  store.subscribe((live) => {
    if (isOffScreen() && onlyATick(live)) return;
    show(live);
  });
  onAppStateEdge(isOffScreen, (offScreen) => {
    if (!offScreen) show(store.getState());
  });
  const visible: Pick<StoreApi<S>, 'getState' | 'getInitialState' | 'subscribe'> = {
    getState: () => shown,
    getInitialState: store.getInitialState,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const useShown = <U>(selector?: (state: S) => U) =>
    useStore(visible, selector ?? (identity as (state: S) => U));
  return Object.assign(useShown, store) as UseBoundStore<StoreApi<S>>;
}

const identity = <T>(value: T): T => value;
