import { TabList, TabSlot, TabTrigger, Tabs } from 'expo-router/ui';
import { useState } from 'react';
import { View } from 'react-native';

import { MiniPlayer } from '@/components/player/mini-player';
import { AuthGate } from '@/components/shell/auth-gate';
import { TABS } from '@/components/shell/destinations';
import { DockedPlayer } from '@/components/shell/docked-player';
import { DrawerSlot } from '@/components/shell/drawer-slot';
import { PhoneTabBar } from '@/components/shell/phone-tab-bar';
import { useShellEffects } from '@/components/shell/use-shell-effects';
import { WideTop } from '@/components/shell/wide-top';
import { useLayout } from '@/lib/layout';

/**
 * The web shell: headless `expo-router/ui` Tabs over the SAME `(home)`/`(library)`/...
 * route groups the native NativeTabs uses, so router state (every push, back, and cold
 * deep link) behaves identically across platforms. The `TabList` only registers the tab
 * routes and is never shown - our chrome drives the tabs (see `useTabPress`).
 *
 * `<TabSlot/>` sits at the SAME ancestor path at every width; only the sibling chrome
 * toggles. Moving it between wrappers would remount every screen on a resize (and jump
 * the URL to another tab). Phone: the page (with its Stack header), the mini player and
 * our tab bar. Tablet/desktop: top bar + sub-nav + banners, the page beside the drawer
 * slot, the docked player bar.
 */
function WebShell() {
  useShellEffects();
  const layout = useLayout();
  const wide = layout !== 'phone';
  // The mini player floats just above the tab bar, whose height includes the home
  // indicator inset; measure it rather than guess (estimate until the first layout).
  const [tabBarHeight, setTabBarHeight] = useState(64);
  return (
    <Tabs style={{ flex: 1 }}>
      <TabList style={{ display: 'none' }}>
        {TABS.map((d) => (
          <TabTrigger key={d.name} name={d.name} href={d.root} />
        ))}
      </TabList>
      <View className="flex-1 bg-background">
        {wide ? <WideTop /> : null}
        <View className="flex-1 flex-row">
          <View className="flex-1 items-center">
            <View className="w-full max-w-[1480px] flex-1">
              <TabSlot />
            </View>
          </View>
          {layout === 'desktop' ? <DrawerSlot /> : null}
        </View>
        {wide ? null : <MiniPlayer bottomOffset={tabBarHeight} />}
        {wide ? (
          <DockedPlayer />
        ) : (
          <PhoneTabBar onLayout={(e) => setTabBarHeight(e.nativeEvent.layout.height)} />
        )}
      </View>
    </Tabs>
  );
}

export default function AppGroupLayout() {
  return (
    <AuthGate>
      <WebShell />
    </AuthGate>
  );
}
