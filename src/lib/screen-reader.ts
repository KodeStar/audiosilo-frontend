import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * Whether VoiceOver or TalkBack is on, kept current from the system (fe#267), for code
 * outside React that times things for the listener (a toast's auto-dismiss), and for a
 * component that changes with it (`useScreenReader`: the reader's top bar never hides,
 * fe#246). The web can't tell: there it is always false, and what needs it pauses on hover
 * and focus instead.
 */
let enabled = false;
let watching = false;
const listeners = new Set<() => void>();

function set(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  for (const listener of listeners) listener();
}

/** Starts following the system's screen reader state (once; a no-op on the web). */
export function watchScreenReader(): void {
  if (watching || Platform.OS === 'web') return;
  watching = true;
  AccessibilityInfo.isScreenReaderEnabled()
    .then(set)
    .catch(() => {});
  AccessibilityInfo.addEventListener('screenReaderChanged', set);
}

/** Whether a screen reader is on now (`watchScreenReader` keeps it current). */
export function screenReaderOn(): boolean {
  return enabled;
}

function subscribe(listener: () => void): () => void {
  // Asked again for each component that starts following it (the first starts the watch,
  // which asks): a change the system's event never brought (one made while the app was
  // away) is not kept. The web never watches, nor asks.
  if (watching) {
    AccessibilityInfo.isScreenReaderEnabled()
      .then(set)
      .catch(() => {});
  } else {
    watchScreenReader();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a screen reader is on, re-rendering when it is turned on or off. */
export function useScreenReader(): boolean {
  return useSyncExternalStore(subscribe, screenReaderOn, screenReaderOn);
}
