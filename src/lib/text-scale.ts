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

/** The web's root font size over 16 px, measured (1 where there is no document, the static
 * export). */
function measureWebScale(): number {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return 1;
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(px) && px > 0 ? px / WEB_BASE_PX : 1;
}

/** The scale now: the system font scale on iOS and Android, the root font size over 16 px on
 * the web (the probe's cached value while anything listens and a probe runs,
 * `subscribeWeb`). Never below a sliver, so a divisor stays sane. */
export function readFontScale(): number {
  if (Platform.OS === 'web') return webScale ?? measureWebScale();
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

// The web's scale while anything listens under a probe, else null (a read measures). One
// hidden probe, 1rem wide, under a ResizeObserver: a browser font size changed mid-session
// (in its settings, or a root font size a stylesheet sets) resizes the probe, so the change
// is picked up at once, and a read between changes costs no `getComputedStyle` (fe#305).
// Page zoom leaves a rem the same number of CSS px, so it moves nothing, as intended.
let webScale: number | null = null;
const webListeners = new Set<() => void>();
let stopProbe: (() => void) | null = null;

function startProbe(): (() => void) | null {
  if (typeof document === 'undefined' || !document.body || typeof ResizeObserver === 'undefined') {
    return null;
  }
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:absolute;top:0;left:-9999px;width:1rem;height:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const observer = new ResizeObserver(() => {
    const next = measureWebScale();
    if (next === webScale) return;
    webScale = next;
    for (const listener of webListeners) listener();
  });
  observer.observe(probe);
  return () => {
    observer.disconnect();
    probe.remove();
  };
}

function subscribeWeb(onChange: () => void): () => void {
  webListeners.add(onChange);
  if (webListeners.size === 1) {
    stopProbe = startProbe();
    // Cached only under a probe: with none (no ResizeObserver) nothing would ever refresh
    // the value, so a read keeps measuring, as it does with no listener.
    webScale = stopProbe ? measureWebScale() : null;
  }
  return () => {
    webListeners.delete(onChange);
    if (webListeners.size > 0) return;
    stopProbe?.();
    stopProbe = null;
    webScale = null;
  };
}

// Dimensions' `change` fires when the font scale changes on iOS and Android.
function subscribe(onChange: () => void): () => void {
  if (Platform.OS === 'web') return subscribeWeb(onChange);
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
