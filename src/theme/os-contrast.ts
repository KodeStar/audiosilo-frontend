import { AccessibilityInfo, Platform } from 'react-native';

/**
 * Whether the OS asks for more contrast. iOS: Settings > Accessibility > Display & Text
 * Size > Increase Contrast (UIKit's "darker system colors"). Android: high contrast text
 * (Settings > Accessibility; "Outline text" on Android 16). Web: `os-contrast.web.ts`.
 * A failed or missing read counts as "no", so it never holds the app up.
 */
export function readOsHighContrast(): Promise<boolean> {
  const read =
    Platform.OS === 'ios'
      ? AccessibilityInfo.isDarkerSystemColorsEnabled()
      : Platform.OS === 'android'
        ? AccessibilityInfo.isHighTextContrastEnabled()
        : Promise.resolve(false);
  return read.then(
    (on) => on === true,
    () => false,
  );
}

/** Calls `onChange` whenever the OS setting above changes; returns the unsubscribe. */
export function watchOsHighContrast(onChange: (on: boolean) => void): () => void {
  const event =
    Platform.OS === 'ios'
      ? 'darkerSystemColorsChanged'
      : Platform.OS === 'android'
        ? 'highTextContrastChanged'
        : null;
  if (!event) return () => undefined;
  const sub = AccessibilityInfo.addEventListener(event, (on) => onChange(on === true));
  return () => sub.remove();
}
