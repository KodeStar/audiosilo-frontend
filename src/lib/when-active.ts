import { type Href, router } from 'expo-router';
import { AppState } from 'react-native';

/**
 * Run `fn` once the app is in the foreground: now when it already is, else on the next
 * change to `active`. For navigation that playback triggers while the app is in the
 * background: a screen pushed then (on iOS a modal that cannot be presented) leaves the
 * app black on return. Returns a cancel function.
 */
export function whenActive(fn: () => void): () => void {
  if (AppState.currentState === 'active') {
    fn();
    return () => {};
  }
  const sub = AppState.addEventListener('change', (state) => {
    if (state !== 'active') return;
    sub.remove();
    fn();
  });
  return () => sub.remove();
}

/**
 * Run `fn` each time the app comes back to the foreground (a change to `active` from
 * any other state), and `onLeave` on each change to any state but `active`. For the
 * framework-free controllers started from the root layout (the address runner, the
 * place reconcile). Returns the stop function.
 */
export function onForeground(fn: () => void, onLeave?: () => void): () => void {
  let state = AppState.currentState;
  const sub = AppState.addEventListener('change', (next) => {
    const wasAway = state !== 'active';
    state = next;
    if (next !== 'active') onLeave?.();
    else if (wasAway) fn();
  });
  return () => sub.remove();
}

/** Go to `href` once the app is in the foreground (see `whenActive`): pushed, or in
 * place of the current screen with `replace`. Returns a cancel function. */
export function navigateWhenActive(href: Href, { replace = false } = {}): () => void {
  return whenActive(() => (replace ? router.replace(href) : router.push(href)));
}
