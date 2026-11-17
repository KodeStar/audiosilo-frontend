import { type ImperativeRouter, router, useRouter } from 'expo-router';
import { useEffect } from 'react';

/**
 * Back to the app from onboarding (connect, sign-in, demo), on Home. Never `replace` or
 * `<Redirect>` (which replaces): `(app)` is the root stack's `anchor` and already sits
 * under onboarding, so a replace stacked a second `(app)` on top of it. `dismissTo` pops
 * back to the one underneath.
 */
export function leaveOnboarding() {
  dismissHome(router);
}

/** The one way back, through `nav`: the module router, or a hook's. */
function dismissHome(nav: Pick<ImperativeRouter, 'dismissTo'>) {
  nav.dismissTo('/');
}

/** `leaveOnboarding` as a render-time exit, where a screen would otherwise return
 * `<Redirect href="/" />`, through `useRouter()`. The module-level `router` throws while no
 * root navigator is mounted (expo-router 58). In the app one always is before a screen's
 * effect runs (its ref is attached in the commit, ahead of any effect), but a screen
 * rendered on its own, as a Jest test does, runs its effects without one. */
export function LeaveOnboarding() {
  const nav = useRouter();
  useEffect(() => dismissHome(nav), [nav]);
  return null;
}
