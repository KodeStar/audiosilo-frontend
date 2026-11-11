import { AppState } from 'react-native';

type Listener = (state: string) => void;

/**
 * The app's state as a test sets it: `active` until `becomes` says otherwise, told to
 * every `AppState` listener, as a phone locking or a tab hiding does.
 *
 * React Native's jest `AppState` is a bare mock: its `currentState` is not a state and its
 * listeners are only recorded. Call this once at the top of a suite, AFTER its imports: the
 * modules that began watching as they were imported (the player store, a `quietOffScreen`
 * hook) are in the mock's recorded calls, which the suite's first `clearAllMocks` forgets,
 * so they are taken now; a listener added later (a mounted hook) is taken as it comes.
 */
export function driveAppState(): {
  becomes: (state: 'active' | 'inactive' | 'background') => void;
} {
  let current = 'active';
  const add = AppState.addEventListener as unknown as jest.Mock;
  const listeners: Listener[] = add.mock.calls
    .filter(([type]) => type === 'change')
    .map(([, listener]) => listener as Listener);
  add.mockImplementation((type: string, listener: Listener) => {
    if (type === 'change') listeners.push(listener);
    return {
      remove: () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      },
    };
  });
  Object.defineProperty(AppState, 'currentState', { get: () => current, configurable: true });
  return {
    becomes(state) {
      current = state;
      for (const listener of [...listeners]) listener(state);
    },
  };
}
