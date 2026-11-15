/**
 * The Android tab bar's label size (fe#267). react-native-screens sets the Material bar's
 * labels in sp, so they grow with the system font scale with no limit: at Android's 2.0
 * even the one label `labelVisibilityMode="selected"` leaves ended in "Ho...". The label
 * follows the text size up to `TAB_LABEL_MAX_SCALE`, and no further than the longest tab
 * name fits its slot (a fifth of the window: 64 dp at the largest display size, where
 * 1.3x still cut "Downl..."). It never drops below the size the system would draw at the
 * default text size; a name too long even for that (French "Téléchargements") ends in
 * "..." as it does without large text. TalkBack reads every tab's name in full.
 */

/** Material's bar label, `design_bottom_navigation_text_size` (sp). */
export const TAB_LABEL_BASE_SP = 12;

/** How far the bar's labels follow the text size. */
export const TAB_LABEL_MAX_SCALE = 1.3;

/** A label's width per character, in ems, with a margin: on a Pixel the bar's "Downloads"
 * measures 0.57 em a character (211 px at 15.6 dp, density 2.625), and at the largest
 * display size it was cut at 15.6 dp in its 64 dp slot. */
export const TAB_LABEL_EM_PER_CHAR = 0.62;

/** The dp size the label is drawn at: grown with `scale` to the cap, within what fits a
 * `slotDp`-wide slot for a `longest`-character name, never below the default size. */
export function tabLabelDrawnDp(scale: number, slotDp: number, longest: number): number {
  const grown = TAB_LABEL_BASE_SP * Math.min(scale, TAB_LABEL_MAX_SCALE);
  const fits = slotDp > 0 && longest > 0 ? slotDp / (longest * TAB_LABEL_EM_PER_CHAR) : Infinity;
  const floor = TAB_LABEL_BASE_SP * Math.min(scale, 1);
  return Math.max(Math.min(grown, fits), floor);
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
export function tabLabelFontSize(scale: number, slotDp: number, longest: number): number {
  return tabLabelDrawnDp(scale, slotDp, longest) / scale + (scale + slotDp / 100) / 10_000;
}
