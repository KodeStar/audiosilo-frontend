import { type ReactNode, useRef } from 'react';
import { Platform, View } from 'react-native';

import { CONTENT_WIDTH, useLayout } from '@/lib/layout';

import { DockedPlayer } from './docked-player';
import { DrawerSlot } from './drawer-slot';
import { setFrameBottom } from './shell-metrics';
import { WideTop } from './wide-top';

/**
 * The frame both platform shells put around their ONE navigator (`children`: NativeTabs
 * on iOS/Android, `<TabSlot/>` on web). The navigator sits at the SAME ancestor path at
 * every width; only the sibling chrome toggles - moving it would remount every screen on
 * a resize (and on web jump the URL to another tab). Tablet/desktop: the top bar, sub-nav
 * and banners above, the page centred and capped beside the desktop drawer slot, the
 * docked player bar below. Phone: the page, then `phoneBottom` (the web shell's mini
 * player and tab bar; on native, where the tab bar draws itself, the one floating mini
 * player, absolutely positioned over it).
 */
export function ShellFrame({
  children,
  phoneBottom,
}: {
  children: ReactNode;
  phoneBottom?: ReactNode;
}) {
  const layout = useLayout();
  const wide = layout !== 'phone';
  // Native: the frame's bottom in `measureInWindow` space, which the tab stacks measure
  // the native tab bar against (`frameBottom` in shell-metrics).
  const root = useRef<View>(null);
  const measure = () =>
    root.current?.measureInWindow((_x, y, _w, h) => {
      if (h > 0) setFrameBottom(y + h);
    });
  return (
    <View
      ref={root}
      onLayout={Platform.OS === 'web' ? undefined : measure}
      className="flex-1 bg-background"
    >
      {wide ? <WideTop /> : null}
      <View className="flex-1 flex-row">
        <View className="flex-1 items-center">
          <View className={`${CONTENT_WIDTH} flex-1`}>{children}</View>
        </View>
        {layout === 'desktop' ? <DrawerSlot /> : null}
      </View>
      {wide ? <DockedPlayer /> : phoneBottom}
    </View>
  );
}
