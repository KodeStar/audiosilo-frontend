import type { Ref } from 'react';
import { ScrollView, type ScrollViewProps } from 'react-native';

import { useMiniPlayerInset } from '@/components/player/mini-player';
import { cn } from '@/lib/utils';

/** A tab page's gutters: 16 on a phone and tablet, 32 across on desktop. */
export const TAB_PAGE_GUTTER = 'p-4 lg:px-8';

/**
 * The scroll props every tab page's scroller shares (what `TabPageScroll` sets; a list
 * spreads them itself).
 *
 * `contentInsetAdjustmentBehavior: 'automatic'`: iOS lays a tab page out under its
 * translucent native tab bar (and the iOS 26 tab bar accessory, the mini player there).
 * React Native's ScrollView defaults to `'never'`; react-native-screens flips that to
 * `'automatic'` (UIKit's own default, which insets the content by the bar) only for the
 * FIRST ScrollView in the screen's first-descendant chain. On a page with sections (the
 * You hub, the Library modes) that is the phone's horizontal segmented control, so the
 * page's own scroller is never found and its end scrolls under the bar: the tap meant for
 * the last row lands on a tab. Every tab page scroller asks for the inset itself. It does
 * nothing where the scroller does not reach the bar, nor on Android and web (Android lays
 * the page out above its bar).
 *
 * `keyboardShouldPersistTaps: 'handled'`: a tap on a row or a button while the keyboard is
 * up does its job, rather than only closing the keyboard.
 */
export const TAB_PAGE_SCROLL_PROPS = {
  contentInsetAdjustmentBehavior: 'automatic',
  keyboardShouldPersistTaps: 'handled',
} as const;

/**
 * A tab page's scroller (the hub's columns, Settings, Account, the Library's Folders and
 * Collections modes): `TAB_PAGE_SCROLL_PROPS`, the page gutters (`gutter={false}` for a
 * page that pads itself) and the bottom room the phone's floating mini player needs
 * (`useMiniPlayerInset`). A list (FlatList, FlashList) uses the same three parts:
 * `TAB_PAGE_SCROLL_PROPS` and `useMiniPlayerInset()`.
 */
export function TabPageScroll({
  ref,
  gutter = true,
  className,
  contentContainerClassName,
  contentContainerStyle,
  ...rest
}: ScrollViewProps & { ref?: Ref<ScrollView>; gutter?: boolean }) {
  const paddingBottom = useMiniPlayerInset();
  return (
    <ScrollView
      ref={ref}
      className={cn('flex-1', className)}
      contentContainerClassName={cn(gutter && TAB_PAGE_GUTTER, contentContainerClassName)}
      contentContainerStyle={[{ paddingBottom }, contentContainerStyle]}
      {...TAB_PAGE_SCROLL_PROPS}
      {...rest}
    />
  );
}
