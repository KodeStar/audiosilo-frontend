import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ToastHost } from '@/components/ui/toast';
import { useLayout } from '@/lib/layout';
import { usePlayer } from '@/playback/store';

import { ACCESSORY_SUPPORTED } from './accessory-support';
import { useActiveTab } from './destinations';
import { useShellMetrics } from './shell-metrics';
import { toastBottomOffset } from './toast-offset';

/**
 * The app's one `ToastHost` (root layout, beside the PortalHost, so a toast also shows
 * over the full-screen player), lifted clear of whatever chrome is at the bottom: the
 * phone tab bar and mini player, or the docked player bar (`toastBottomOffset`).
 */
export function ShellToastHost() {
  const layout = useLayout();
  const insets = useSafeAreaInsets();
  const overTabs = useActiveTab() !== null;
  const playerLoaded = usePlayer((s) => s.nowPlaying != null);
  const tabBarHeight = useShellMetrics((s) => s.tabBarHeight);
  const dockHeight = useShellMetrics((s) => s.dockHeight);
  const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
  const bottom = toastBottomOffset({
    layout,
    platform,
    overTabs,
    safeBottom: insets.bottom,
    playerLoaded,
    accessory: ACCESSORY_SUPPORTED,
    // Only the web phone bar is ours to measure; a native bar would keep a stale value.
    tabBarHeight: platform === 'web' ? tabBarHeight : undefined,
    dockHeight,
  });
  return <ToastHost bottomInset={bottom} />;
}
