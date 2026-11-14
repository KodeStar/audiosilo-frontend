import { useSyncExternalStore } from 'react';
import { Dimensions, Platform } from 'react-native';

/**
 * The reader's text size, as one number every platform agrees on (fe#267), and the one
 * threshold past which a layout changes shape for it.
 *
 * - iOS and Android: the system font scale (`fontScale`: Dynamic Type, Android's font
 *   size), which React Native already applies to every `<Text>`. Boxes sized in rem or px
 *   do not grow with it, so a row that puts a label beside a control runs out of room.
 * - The web: the root font size against the browser's default 16 px (a reader who sets
 *   24 px in the browser gets 1.5). rem-sized boxes grow with it; px-sized text does not.
 *
 * Page zoom is not text size (it scales everything, so nothing needs to change shape).
 */

/** At or past this scale the text is "large": inline rows stack (label above its control),
 * option tiles and segmented controls wrap their words, one-line labels may take more.
 * 1.3 is Android's "Largest" before its accessibility steps, iOS's largest standard size
 * (xxxLarge 1.35) and every accessibility size, and a 21 px browser font or more. */
export const LARGE_TEXT_SCALE = 1.3;

/** The browser's default root font size, which a scale of 1 means. */
const WEB_BASE_PX = 16;

/** The scale now: the system font scale on iOS and Android, the root font size over 16 px on
 * the web (1 where there is no document, the static export). Never below a sliver, so a
 * divisor stays sane. */
export function readFontScale(): number {
  if (Platform.OS === 'web') {
    if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return 1;
    const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Number.isFinite(px) && px > 0 ? px / WEB_BASE_PX : 1;
  }
  const scale = Dimensions.get('window').fontScale;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Whether `scale` is large text (`LARGE_TEXT_SCALE`). */
export function isLargeText(scale: number): boolean {
  return scale >= LARGE_TEXT_SCALE;
}

/**
 * A size that follows the text scale up to `maxScale` and never shrinks below `base`:
 * a control drawn in px (an icon, the play button) that grows with the words around it.
 */
export function scaleCapped(base: number, scale: number, maxScale: number): number {
  return Math.round(base * Math.max(1, Math.min(scale, maxScale)));
}

/** A one- or few-line cap that lifts under large text: the words wrap instead of ending in
 * "...". `undefined` is no cap (React Native's `numberOfLines`). */
export function linesFor(lines: number, large: boolean): number | undefined {
  return large ? undefined : lines;
}

// Dimensions' `change` fires when the font scale changes on iOS and Android (and on any
// window resize on the web, which is when a browser re-reads its root font size too).
function subscribe(onChange: () => void): () => void {
  const subscription = Dimensions.addEventListener('change', onChange);
  return () => subscription.remove();
}

const readLarge = () => isLargeText(readFontScale());
const serverScale = () => 1;
const serverLarge = () => false;

/** The current text scale (`readFontScale`); re-renders when it changes. */
export function useFontScale(): number {
  return useSyncExternalStore(subscribe, readFontScale, serverScale);
}

/** Whether the text is large (`LARGE_TEXT_SCALE`). Re-renders only when the scale crosses
 * the threshold, not on every step of it. */
export function useLargeText(): boolean {
  return useSyncExternalStore(subscribe, readLarge, serverLarge);
}
