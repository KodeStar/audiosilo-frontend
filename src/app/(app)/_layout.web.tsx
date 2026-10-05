import { TabList, TabSlot, TabTrigger, Tabs } from 'expo-router/ui';

import { MiniPlayer } from '@/components/player/mini-player';
import { AuthGate } from '@/components/shell/auth-gate';
import { CommandPalette, usePaletteShortcut } from '@/components/shell/command-palette';
import { TABS, useActiveTab } from '@/components/shell/destinations';
import { PhoneTabBar } from '@/components/shell/phone-tab-bar';
import { setShellMetric, useShellMetrics } from '@/components/shell/shell-metrics';
import { ShellFrame } from '@/components/shell/shell-frame';
import { useShellEffects } from '@/components/shell/use-shell-effects';

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
 * slot, the docked player bar. The command palette (⌘K, `/`, the omnisearch) opens over
 * any tab page, at every width.
 */
function WebShell() {
  useShellEffects();
  // Not over the full player or the finished screen (root modals: no active tab).
  usePaletteShortcut(useActiveTab() !== null);
  // The mini player (and the toasts) float just above the tab bar, whose height includes
  // the home indicator inset; measure it rather than guess (estimate until laid out).
  const tabBarHeight = useShellMetrics((s) => s.tabBarHeight) ?? 64;
  return (
    <Tabs style={{ flex: 1 }}>
      <TabList style={{ display: 'none' }}>
        {TABS.map((d) => (
          <TabTrigger key={d.name} name={d.name} href={d.root} />
        ))}
      </TabList>
      <ShellFrame
        phoneBottom={
          <>
            <MiniPlayer bottomOffset={tabBarHeight} />
            <PhoneTabBar
              onLayout={(e) => setShellMetric('tabBarHeight', e.nativeEvent.layout.height)}
            />
          </>
        }
      >
        <TabSlot />
      </ShellFrame>
      <CommandPalette />
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
