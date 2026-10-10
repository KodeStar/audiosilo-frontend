import { router, usePathname, useRootNavigationState } from 'expo-router';
import { useEffect } from 'react';

import { KIDS_PATH, kidsAllowsPath } from './kids-model';
import { useKidsActive } from './use-kids';

/**
 * Keeps a kids profile in kids mode (Phase 8): whenever the active profile is in kids
 * mode and the route is anywhere it may not be (`kidsAllowsPath`: the tabs, search,
 * settings, downloads, the full player, the end credits, the year story, a deep link into
 * any of them), it goes to `/kids`. Mounted once, by the root layout, so it covers the
 * root routes too (the `(app)` gate only covers the shell, and renders nothing of it for
 * a kids profile).
 *
 * `dismissTo`, not `replace`: when `/kids` is already in the root stack (the end credits
 * or the player pushed over it) it pops back to it rather than stacking a second one;
 * when it is not, it replaces the current route. Waits for the root navigator (a
 * navigation before it mounts throws).
 */
export function KidsRouteGuard() {
  const kids = useKidsActive();
  const pathname = usePathname();
  const ready = !!useRootNavigationState()?.key;
  useEffect(() => {
    if (ready && kids && !kidsAllowsPath(pathname)) router.dismissTo(KIDS_PATH);
  }, [ready, kids, pathname]);
  return null;
}
