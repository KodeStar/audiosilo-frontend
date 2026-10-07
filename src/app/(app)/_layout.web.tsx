import { TabList, TabSlot, TabTrigger, Tabs } from 'expo-router/ui';
import { View } from 'react-native';

import { MiniPlayer } from '@/components/player/mini-player';
import { ShortcutsDialog } from '@/components/player/shortcuts-dialog';
import { usePlayerShortcuts } from '@/components/player/use-player-shortcuts';
import { ShellPlayerOverlays } from '@/components/player/player-sheet-host';
import { AuthGate } from '@/components/shell/auth-gate';
import { CommandPalette, usePaletteShortcut } from '@/components/shell/command-palette';
import { TABS, useActiveTab } from '@/components/shell/destinations';
import { PhoneTabBar } from '@/components/shell/phone-tab-bar';
import { ShellFrame } from '@/components/shell/shell-frame';
import { useShellEffects } from '@/components/shell/use-shell-effects';
import { UpNextSheet } from '@/components/upnext/up-next-sheet';
import { useUpNextShortcut } from '@/components/upnext/use-up-next-shortcut';

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
 * any tab page, at every width; so does Up next's tablet/phone sheet (Q toggles Up next),
 * and the keyboard shortcuts overlay (?).
 */
function WebShell() {
  useShellEffects();
  // Not over the full player or the finished screen (root modals: no active tab).
  const onTabPage = useActiveTab() !== null;
  usePaletteShortcut(onTabPage);
  useUpNextShortcut(onTabPage);
  // The player's keys (Space, J/K/L, arrows, [ ], B, P, Z, ?, Esc): on every page AND over
  // the full player, which is a root route, not a dialog.
  usePlayerShortcuts();
  return (
    <Tabs style={{ flex: 1 }}>
      <TabList style={{ display: 'none' }}>
        {TABS.map((d) => (
          <TabTrigger key={d.name} name={d.name} href={d.root} />
        ))}
      </TabList>
      <ShellFrame
        phoneBottom={
          // The mini player floats over the page, its bottom edge on the tab bar's top
          // edge (`100%` of this wrapper, whatever the bar's height with the safe area).
          <View>
            <MiniPlayer bottomOffset="100%" />
            <PhoneTabBar />
          </View>
        }
      >
        <TabSlot />
      </ShellFrame>
      <UpNextSheet />
      <ShellPlayerOverlays />
      <CommandPalette />
      <ShortcutsDialog />
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
