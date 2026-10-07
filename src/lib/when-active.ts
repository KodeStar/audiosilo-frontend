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
