/**
 * Scroll props for a phone tab page's scroller that does not start the page.
 *
 * iOS lays a tab page out under its translucent native tab bar (and the iOS 26 tab bar
 * accessory, the mini player there). React Native's ScrollView defaults to
 * `contentInsetAdjustmentBehavior: 'never'`; react-native-screens flips that to
 * `automatic` (UIKit's own default, which insets the content by the bar) only for the
 * FIRST ScrollView in the screen's first-descendant chain. A page whose scroller sits
 * after other content (the You hub's sections under its segmented control) is never
 * found, so its end scrolls under the bar: the tap meant for the last row lands on a
 * tab. Such a scroller spreads these props to ask for the same inset itself. They do
 * nothing where the scroller does not reach the bar, nor on Android and web (Android
 * lays the page out above its bar).
 */
export const TAB_BAR_SCROLL_INSETS = { contentInsetAdjustmentBehavior: 'automatic' } as const;
