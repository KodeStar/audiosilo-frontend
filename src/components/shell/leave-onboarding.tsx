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
 * `<Redirect href="/" />`, through `useRouter()` (CONVENTIONS.md, "Navigation at mount"). */
export function LeaveOnboarding() {
  const nav = useRouter();
  useEffect(() => dismissHome(nav), [nav]);
  return null;
}
