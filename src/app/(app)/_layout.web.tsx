import { TabList, TabSlot, TabTrigger, Tabs } from 'expo-router/ui';
import { View } from 'react-native';

import { MiniPlayer } from '@/components/player/mini-player';
import { usePlayerShortcuts } from '@/components/player/use-player-shortcuts';
import { AuthGate } from '@/components/shell/auth-gate';
import { TABS, useActiveTab } from '@/components/shell/destinations';
import { usePaletteShortcut } from '@/components/shell/palette-store';
import { PhoneTabBar } from '@/components/shell/phone-tab-bar';
import { ShellFrame } from '@/components/shell/shell-frame';
import { useIsTopShell } from '@/components/shell/top-shell';
import { useShellEffects } from '@/components/shell/use-shell-effects';
import { useUpNextShortcut } from '@/components/upnext/use-up-next-shortcut';
import { deferred } from '@/lib/deferred';

// The shell's overlays open on a key or a press, never on the first screen: they mount once
// the page has painted. The palette (with search) and the keyboard overlay are their own
// chunks, out of the web's start; the player's sheets are in the start anyway (the player
// route imports them too), so only their render waits. Their keys and open states are in
// the shell already, so a key pressed before then opens it once in.
const ShellPlayerOverlays = deferred(() =>
  import('@/components/player/player-sheet-host').then((m) => m.ShellPlayerOverlays),
);
const CommandPalette = deferred(() =>
  import('@/components/shell/command-palette').then((m) => m.CommandPalette),
);
const ShortcutsDialog = deferred(() =>
  import('@/components/player/shortcuts-dialog').then((m) => m.ShortcutsDialog),
);

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
  // The shell's singletons (keys, palette, overlays) live in the top shell only, should a
  // second one ever be stacked over this one.
  const top = useIsTopShell();
  // Not over the full player or the finished screen (root modals: no active tab).
  const onTabPage = useActiveTab() !== null;
  usePaletteShortcut(onTabPage && top);
  useUpNextShortcut(onTabPage && top);
  // The player's keys (Space, J/K/L, arrows, [ ], B, P, Z, ?, Esc): on every page AND over
  // the full player, which is a root route, not a dialog.
  usePlayerShortcuts(top);
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
      {top ? (
        <>
          <ShellPlayerOverlays />
          <CommandPalette />
          <ShortcutsDialog />
        </>
      ) : null}
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
