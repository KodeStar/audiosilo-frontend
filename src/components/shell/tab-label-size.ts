/**
 * The Android tab bar's label size (fe#267). react-native-screens sets the Material bar's
 * labels in sp, so they grow with the system font scale with no limit: at Android's 2.0
 * even the one label `labelVisibilityMode="selected"` leaves ended in "Ho...". The label
 * follows the text size up to the cap and fits the widest translated label. Android
 * measures all five names in its own system font at the base size.
 */

/** Material's bar label, `design_bottom_navigation_text_size` (sp). */
export const TAB_LABEL_BASE_SP = 12;

/** How far the bar's labels follow the text size. */
export const TAB_LABEL_MAX_SCALE = 1.3;

/** Fit the widest label, measured at the base size, inside one slot. Leave two dp
 * clear for native rounding of the label and each tab's share of the window. */
export function tabLabelDrawnDp(scale: number, slotDp: number, measuredWidth: number): number {
  const grown = TAB_LABEL_BASE_SP * Math.min(scale, TAB_LABEL_MAX_SCALE);
  if (slotDp <= 2 || measuredWidth <= 0) return grown;
  return Math.min(grown, (TAB_LABEL_BASE_SP * (slotDp - 2)) / measuredWidth);
}

/**
 * The `labelStyle.fontSize` (sp) for `tabLabelDrawnDp`: sp is multiplied by the scale on
 * the native side, so the scale is divided back out.
 *
 * The value also carries the scale and the slot in a sliver (under 0.001 sp): the drawn
 * size is often the same at two scales or display sizes, the bar's appearance would then
 * not change, and react-native-screens, which converts sp to px when it applies it, would
 * keep the px size of the old scale or density after a live change (the activity is not
 * recreated for one, `withFontScaleChanges`). react-native-screens compares the size as a
 * 32-bit float (about 1e-6 apart near 12 sp), so the slot moves it by 1e-6 sp a dp: a
 * display size step (several dp of slot) is then a different float, not the same one.
 *
 * `scale` is `useFontScale`'s, which is never 0 or NaN.
 */
export function tabLabelFontSize(scale: number, slotDp: number, measuredWidth: number): number {
  return tabLabelDrawnDp(scale, slotDp, measuredWidth) / scale + (scale + slotDp / 100) / 10_000;
}
