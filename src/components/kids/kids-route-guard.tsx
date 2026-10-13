import { router, usePathname, useRootNavigationState } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { endKidsConnect, kidsConnectAllowed } from '@/components/profiles/connect-intent';
import { toast } from '@/components/ui/toast';
import { useProfiles } from '@/stores/profiles';

import { isConnectPath, KIDS_PATH, kidsAllowsPath } from './kids-model';
import { useKidsActive } from './use-kids';

/**
 * Keeps a kids profile in kids mode (Phase 8): whenever the active profile is in kids
 * mode and the route is anywhere it may not be (`kidsAllowsPath`: the tabs, search,
 * settings, downloads, the full player, the end credits, the year story, the connect
 * flow, a deep link into any of them), it goes to `/kids`. Mounted once, by the root
 * layout, so it covers the root routes too (the `(app)` gate only covers the shell, and
 * renders nothing of it for a kids profile).
 *
 * The connect flow (8b-1, D1): a link into it (`audiosilo://connect?token=`, a QR scanned
 * elsewhere, `/web/connect`) while a kids profile listens goes back to `/kids` with a toast
 * asking a grown-up to open it (the grown-up holds Grown-ups, chooses themselves with their
 * PIN, then opens the link again; `connect/_layout.tsx` renders none of the flow
 * meanwhile, so the link's token stays unspent). Only a grown-up's "Add someone" from
 * "Who's listening?" on a device with no grown-up gets through (`kidsConnectAllowed`); that
 * pass ends once the route is anywhere but the flow or the picker. A kid's first sign-in,
 * which turns kids mode on while the flow is still on screen, goes to `/kids` without a
 * toast (no "Your library is ready." for a kid's account).
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
  const { t } = useTranslation();
  const kids = useKidsActive();
  const hydrated = useProfiles((s) => s.hydrated);
  const pathname = usePathname();
  const ready = !!useRootNavigationState()?.key;
  // Whether kids mode was on at the guard's last look: a connect route reached while it
  // was is a link (toast); one kids mode just turned on over is a kid's first sign-in.
  const wasKids = useRef(kids);
  useEffect(() => {
    const before = wasKids.current;
    wasKids.current = kids;
    if (!ready) return;
    const connect = isConnectPath(pathname);
    if (!connect && pathname !== '/profiles') endKidsConnect();
    if (kids && !kidsAllowsPath(pathname, { connect: kidsConnectAllowed() })) {
      if (connect && before) {
        toast({ title: t('kids.link.title'), description: t('kids.link.body') });
      }
      router.dismissTo(KIDS_PATH);
    } else if (!kids && hydrated && pathname === KIDS_PATH) router.dismissTo('/');
  }, [ready, kids, hydrated, pathname, t]);
  return null;
}
