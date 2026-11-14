/**
 * The Android tab bar's label size (fe#267). react-native-screens sets the Material bar's
 * labels in sp, so they grow with the system font scale with no limit: at Android's 2.0
 * (and a large display size) even the one label `labelVisibilityMode="selected"` leaves
 * ends in "Ho...". The label follows the text size up to `TAB_LABEL_MAX_SCALE`, which
 * still fits "Downloads" in its slot; the tab's name is read in full by TalkBack.
 */

/** Material's bar label, `design_bottom_navigation_text_size` (sp). */
export const TAB_LABEL_BASE_SP = 12;

/** How far the bar's labels follow the text size. */
export const TAB_LABEL_MAX_SCALE = 1.3;

/**
 * The `labelStyle.fontSize` (sp) that draws the label at the base size times the scale,
 * capped: sp is multiplied by the scale on the native side, so the cap divides it back out.
 *
 * The value also carries the scale in a sliver (1/10000 sp per step): below the cap the
 * size would otherwise be the same number at every scale, the bar's appearance would not
 * change, and react-native-screens would keep the size it drew at the old scale after a
 * live text-size change (the activity is not recreated for one, `withFontScaleChanges`).
 *
 * `scale` is `useFontScale`'s, which is never 0 or NaN.
 */
export function tabLabelFontSize(scale: number): number {
  return (TAB_LABEL_BASE_SP * Math.min(scale, TAB_LABEL_MAX_SCALE)) / scale + scale / 10_000;
}
