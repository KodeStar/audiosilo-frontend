import { Redirect, router } from 'expo-router';
import { useEffect, type ReactNode } from 'react';

import { useOptionalApi } from '@/api/provider';
import { asksAtLaunch, takeLaunchDecision } from '@/components/profiles/profiles-model';
import { PROFILES_HREF } from '@/components/profiles/use-choose-profile';
import { useKidsActive } from '@/components/kids/use-kids';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { accountFlagsKnown } from '@/lib/account';
import { currentNavState, topRootRoute } from '@/lib/root-stack';
import { useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

/**
 * The guard around the authenticated app, shared by both `(app)` layouts (native tabs
 * and the web shell): a spinner while the session hydrates, a redirect to onboarding
 * when there is no connection, else the shell.
 *
 * Each content screen (book/library/account) scopes ITSELF to its `?connection=` via
 * `<ContentScope>` from its own local param (reliable on a cold deep link, unlike a
 * layout-level global param). Aggregated screens (Home/Search) carry no connection and
 * default to the fallback scope, so nothing is wrapped here.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useSession((s) => s.status);
  const setUser = useSession((s) => s.setUser);
  const api = useOptionalApi();
  const kids = useKidsActive();

  // Backfill the cached user's account flags (has_password) for a session
  // persisted before those flags existed - fresh logins already carry
  // them, so we only spend the round-trip when they're missing, and read the
  // user via getState() so this runs once per auth rather than on every change.
  // Best-effort: real auth failures are surfaced by the regular request flows.
  useEffect(() => {
    if (status !== 'authenticated' || !api) return;
    if (accountFlagsKnown(useSession.getState().user)) return;
    let cancelled = false;
    api
      .me()
      .then((u) => {
        if (!cancelled) void setUser(u).catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status, api, setUser]);

  // "Who's listening?" at a cold launch (Phase 8): once per launch, with two or more people
  // on this device and the setting on. Pushed over the app (a root route), so choosing the
  // person already listening goes back to where the launch was going (a link's page).
  const profilesHydrated = useProfiles((s) => s.hydrated);
  useEffect(() => {
    if (status !== 'authenticated' || !profilesHydrated) return;
    if (!takeLaunchDecision()) return;
    if (asksAtLaunch(useProfiles.getState())) router.push(PROFILES_HREF);
  }, [status, profilesHydrated]);
  // The person listening left this device and someone else is left: they choose (with
  // their PIN) before the app is theirs.
  const chooseRequired = useProfiles((s) => s.chooseRequired);
  useEffect(() => {
    if (status !== 'authenticated' || !chooseRequired) return;
    if (topRootRoute(currentNavState()) !== 'profiles') router.push(PROFILES_HREF);
  }, [status, chooseRequired]);

  // The profiles too (Phase 8): the shell must not mount for a moment as the wrong person
  // (or as a kids profile's grown-up tabs) before they have loaded.
  if (status === 'loading' || (status === 'authenticated' && !profilesHydrated)) {
    return (
      <Screen>
        <Spinner center />
      </Screen>
    );
  }
  if (status === 'unauthenticated') return <Redirect href="/connect" />;
  // Phase 8 kids mode: a kids profile never gets the shell (tabs, search, settings,
  // downloads, the web command palette); the root layout's `KidsRouteGuard` takes it to
  // `/kids`, and this holds the screen until it has.
  if (kids) {
    return (
      <Screen>
        <Spinner center />
      </Screen>
    );
  }
  return <>{children}</>;
}
