import type { ReactNode } from 'react';
import { View } from 'react-native';

import { CONTENT_WIDTH, useLayout } from '@/lib/layout';

import { DockedPlayer } from './docked-player';
import { DrawerSlot } from './drawer-slot';
import { WideTop } from './wide-top';

/**
 * The frame both platform shells put around their ONE navigator (`children`: NativeTabs
 * on iOS/Android, `<TabSlot/>` on web). The navigator sits at the SAME ancestor path at
 * every width; only the sibling chrome toggles - moving it would remount every screen on
 * a resize (and on web jump the URL to another tab). Tablet/desktop: the top bar, sub-nav
 * and banners above, the page centred and capped beside the desktop drawer slot, the
 * docked player bar below. Phone: the page, then `phoneBottom` (the web shell's mini
 * player and tab bar; the native tab bar draws its own).
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
  return (
    <View className="flex-1 bg-background">
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
