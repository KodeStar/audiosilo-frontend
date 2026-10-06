/** The space kept between a toast and the chrome under it. */
const GAP = 12;
/** Only before the bottom chrome's first layout: about a tab bar above the home indicator. */
const FALLBACK_CHROME = 64;

export type ToastChrome = {
  /** True while a tab page is showing; false over a full-screen modal (the player, the
   * finished screen, onboarding), which has no tab bar or dock under it. */
  overTabs: boolean;
  /** Whether there is bottom chrome at all: always on a phone (the tab bar); on tablet
   * and desktop only the docked player bar, while a book is loaded. */
  hasChrome: boolean;
  /** The bottom safe-area inset (the home indicator). */
  safeBottom: number;
  /** The measured top edge of the bottom chrome (`bottomChromeTop`), from the window's
   * bottom edge; undefined until it has been laid out. */
  chromeTop?: number;
};

/**
 * How far above the window's bottom edge toasts sit (STYLEGUIDE section 8: above the tab
 * bar and mini player on a phone, above the docked player bar on tablet and desktop).
 * Pure, so every combination is tested without a shell.
 */
export function toastBottomOffset(c: ToastChrome): number {
  if (!c.overTabs) return c.safeBottom + 16;
  if (!c.hasChrome) return c.safeBottom + 20;
  return (c.chromeTop ?? c.safeBottom + FALLBACK_CHROME) + GAP;
}
