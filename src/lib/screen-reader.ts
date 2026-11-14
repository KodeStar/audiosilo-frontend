import { AccessibilityInfo, Platform } from 'react-native';

/**
 * Whether VoiceOver or TalkBack is on, kept current from the system (fe#267), for code
 * outside React that times things for the listener (a toast's auto-dismiss). The web can't
 * tell: there it is always false, and what needs it pauses on hover and focus instead.
 */
let enabled = false;
let watching = false;

/** Starts following the system's screen reader state (once; a no-op on the web). */
export function watchScreenReader(): void {
  if (watching || Platform.OS === 'web') return;
  watching = true;
  AccessibilityInfo.isScreenReaderEnabled()
    .then((on) => {
      enabled = on;
    })
    .catch(() => {});
  AccessibilityInfo.addEventListener('screenReaderChanged', (on) => {
    enabled = on;
  });
}

/** Whether a screen reader is on now (`watchScreenReader` keeps it current). */
export function screenReaderOn(): boolean {
  return enabled;
}
