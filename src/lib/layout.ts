import { useWindowDimensions } from 'react-native';

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

/** The current form factor; re-renders when the window crosses a threshold. */
export function useLayout(): LayoutClass {
  return layoutFor(useWindowDimensions().width);
}
