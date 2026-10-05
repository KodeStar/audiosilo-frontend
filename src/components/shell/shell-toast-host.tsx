import { ToastHost } from '@/components/ui/toast';
import { useRootInsets } from '@/components/ui/overlay';
import { useLayout } from '@/lib/layout';
import { usePlayer } from '@/playback/store';

import { useActiveTab } from './destinations';
import { bottomChromeTop, useShellMetrics } from './shell-metrics';
import { toastBottomOffset } from './toast-offset';

/**
 * The app's one `ToastHost` (root layout, beside the PortalHost, so a toast also shows
 * over the full-screen player), lifted clear of whatever chrome is at the bottom: the
 * top edge the shell measured (`useShellMetrics`: the phone tab bar and mini player, or
 * the docked player bar), through `toastBottomOffset`.
 */
export function ShellToastHost() {
  const phone = useLayout() === 'phone';
  const insets = useRootInsets();
  const overTabs = useActiveTab() !== null;
  const playerLoaded = usePlayer((s) => s.nowPlaying != null);
  const chromeTop = useShellMetrics((s) => bottomChromeTop(s.edges));
  const bottom = toastBottomOffset({
    overTabs,
    hasChrome: phone || playerLoaded,
    safeBottom: insets.bottom,
    chromeTop,
  });
  return <ToastHost bottomInset={bottom} />;
}
