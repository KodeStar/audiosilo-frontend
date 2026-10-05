import { useSyncExternalStore } from 'react';
import { Dimensions } from 'react-native';

/**
 * The three Stacks form factors (STYLEGUIDE section 2), from the window width:
 * - `phone` (< 640): bottom tabs + mini player, single column, full-screen player modal;
 * - `tablet` (640-1023, iPad portrait): top bar + sub-nav + docked player bar;
 * - `desktop` (>= 1024): the same chrome, plus multi-column grids and the drawer slot.
 *
 * Every layout decision reads this one value, so every screen flips at the same
 * thresholds - never compare a width against a local constant.
 */
export type LayoutClass = 'phone' | 'tablet' | 'desktop';

/** Below this width the app is a phone. */
export const TABLET_MIN_WIDTH = 640;
/** At or above this width the app is a desktop. */
export const DESKTOP_MIN_WIDTH = 1024;

export function layoutFor(width: number): LayoutClass {
  if (width < TABLET_MIN_WIDTH) return 'phone';
  if (width < DESKTOP_MIN_WIDTH) return 'tablet';
  return 'desktop';
}

/** The page column's width class: full width, capped at 1480 (STYLEGUIDE section 2). The
 * shell's page column (`ShellFrame`) and the sub-nav row share it. */
export const CONTENT_WIDTH = 'w-full max-w-[1480px]';

function subscribeWindow(onChange: () => void): () => void {
  const subscription = Dimensions.addEventListener('change', onChange);
  return () => subscription.remove();
}

const currentLayout = (): LayoutClass => layoutFor(Dimensions.get('window').width);

/** The current form factor. A store over the window size that yields the CLASS, so a
 * consumer re-renders only when the window crosses a threshold, not on every resize
 * step (`useWindowDimensions` would re-render it per pixel of a drag). */
export function useLayout(): LayoutClass {
  return useSyncExternalStore(subscribeWindow, currentLayout, currentLayout);
}
