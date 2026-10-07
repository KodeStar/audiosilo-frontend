import { type Insets, Platform } from 'react-native';

/**
 * The 44 pt minimum touch target (STYLEGUIDE section 14) for a control sized in rem.
 *
 * A rem is 16 px on the web but 14 pt on iOS and Android (`polyfills.rem` in
 * `uniwind.config.js`), so a rem-sized class that is 44 px on the web (`h-11`) is 38.5 pt
 * on a phone, and a small control (a 28 pt chip) is far below on both.
 */

/** Points per rem on iOS and Android: `polyfills.rem` in `uniwind.config.js` (the web
 * uses the browser's 16 px root). */
export const NATIVE_REM_PT = 14;

/**
 * The hit slop, on each side, that grows a control `rem` rem across (its class size:
 * `h-11` is 2.75) to 44 on this platform. The SLOP policy, which the player's round
 * controls use on every platform: the control keeps its drawn size and the touch grows
 * around it.
 */
export function slopTo44(rem: number): number {
  const pt = Platform.OS === 'web' ? 16 : NATIVE_REM_PT;
  return Math.max(0, Math.ceil((44 - rem * pt) / 2));
}

/** How a small control reaches 44: a frame class (native) or a hit slop (web). */
export type TouchTarget = {
  /** iOS and Android: the pressable's own frame classes (at least 44 pt on each side the
   * control is sized on), around the drawn control. */
  frameClass?: string;
  /** The web: the slop that grows the drawn control's own box to 44 px. */
  hitSlop?: Insets;
};

/**
 * The FRAME policy for a small control (a chip, a row's icon action) `height` rem tall
 * and, when it has a fixed one, `width` rem wide (a text pill's width is its text's): on
 * iOS and Android the pressable itself is at least 44 pt (`frameClass`), because a slop
 * grows the touch but not the control's frame, which is what the accessibility tree
 * reports and device audits measure; on the web the control keeps its size and a slop
 * grows the touch (`hitSlop`, from `slopTo44`).
 */
export function touchTarget(height: number, width?: number): TouchTarget {
  if (Platform.OS !== 'web') {
    return { frameClass: width === undefined ? 'min-h-[44px]' : 'min-h-[44px] min-w-[44px]' };
  }
  const v = slopTo44(height);
  if (width === undefined) return { hitSlop: { top: v, bottom: v } };
  const h = slopTo44(width);
  return { hitSlop: { top: v, bottom: v, left: h, right: h } };
}
