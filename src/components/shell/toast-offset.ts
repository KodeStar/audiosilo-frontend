import type { LayoutClass } from '@/lib/layout';

/** The space kept between a toast and the chrome under it. */
const GAP = 12;
/** The docked player bar's content height (STYLEGUIDE section 8), before its measurement. */
const DOCK_HEIGHT = 84;
/** The floating phone mini player card (`MiniPlayer`: a 64 cover row + its 2px line). */
const MINI_PLAYER_HEIGHT = 66;
/** The iOS 26 tab bar's bottom accessory pill, with the gap the system leaves above the bar. */
const ACCESSORY_HEIGHT = 56;
/** Native tab bar heights above the home indicator, which the shell can't measure:
 * iOS 26's floating Liquid Glass bar, Android's Material 3 navigation bar. The web phone
 * bar is measured (`tabBarHeight`); this is only its first-frame estimate. */
const TAB_BAR_HEIGHT = { ios: 62, android: 80, web: 64 } as const;

export type ToastChrome = {
  layout: LayoutClass;
  platform: 'ios' | 'android' | 'web';
  /** True while a tab page is showing; false over a full-screen modal (the player, the
   * finished screen, onboarding), which has no tab bar or dock under it. */
  overTabs: boolean;
  /** The bottom safe-area inset (the home indicator). */
  safeBottom: number;
  /** A book is loaded, so the mini player (phone) or the docked player bar shows. */
  playerLoaded: boolean;
  /** The phone mini player lives in the iOS 26 tab bar's bottom accessory. */
  accessory: boolean;
  /** The web phone tab bar's measured height, safe area included. */
  tabBarHeight?: number;
  /** The docked player bar's measured height, safe area included. */
  dockHeight?: number;
};

/**
 * How far above the window's bottom edge toasts sit (STYLEGUIDE section 8: above the tab
 * bar and mini player on a phone, above the docked player bar on tablet and desktop).
 * Pure, so every combination is tested without a shell.
 */
export function toastBottomOffset(c: ToastChrome): number {
  if (!c.overTabs) return c.safeBottom + 16;
  if (c.layout !== 'phone') {
    if (!c.playerLoaded) return c.safeBottom + 20;
    return (c.dockHeight ?? DOCK_HEIGHT + c.safeBottom) + GAP;
  }
  const tabBar = c.tabBarHeight ?? TAB_BAR_HEIGHT[c.platform] + c.safeBottom;
  const player = c.playerLoaded ? (c.accessory ? ACCESSORY_HEIGHT : MINI_PLAYER_HEIGHT) : 0;
  return tabBar + player + GAP;
}
