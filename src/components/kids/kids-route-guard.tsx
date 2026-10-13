import { router, usePathname, useRootNavigationState } from 'expo-router';
import { useEffect } from 'react';

import { useProfiles } from '@/stores/profiles';

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
 *
 * And the other way: `/kids` is a kids profile's only. Leaving kids mode through "Who's
 * listening?" puts the shell over it (the guard replaced the shell's anchor with it), so
 * back, a swipe or web history would land a grown-up on kids mode's screen, showing their
 * own library as stories with no guard: once the profiles have loaded, anyone else on
 * `/kids` goes Home (`dismissTo('/')` takes `/kids` off the root stack).
 */
export function KidsRouteGuard() {
  const kids = useKidsActive();
  const hydrated = useProfiles((s) => s.hydrated);
  const pathname = usePathname();
  const ready = !!useRootNavigationState()?.key;
  useEffect(() => {
    if (!ready) return;
    if (kids && !kidsAllowsPath(pathname)) router.dismissTo(KIDS_PATH);
    else if (!kids && hydrated && pathname === KIDS_PATH) router.dismissTo('/');
  }, [ready, kids, hydrated, pathname]);
  return null;
}
