import { Redirect, useIsFocused } from 'expo-router';
import { useEffect, type ReactNode } from 'react';

import { useOptionalApi } from '@/api/provider';
import { asksAtLaunch, takeLaunchDecision } from '@/components/profiles/profiles-model';
import { openProfiles } from '@/components/profiles/use-choose-profile';
import { useKidsActive } from '@/components/kids/use-kids';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { accountFlagsKnown } from '@/lib/account';
import { signedOutHref } from '@/lib/return-to';
import { currentNavState, topRootRoute } from '@/lib/root-stack';
import { useMustChoose, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import { useStartupQueries } from './use-startup-queries';

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
const pickerOnTop = () => topRootRoute(currentNavState()) === 'profiles';

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
  // The person listening left this device and someone else is left (`mustChoose`, which
  // is persisted: a reload or a cold start is the same): they choose, with their PIN,
  // before the app is anyone's. The shell stays unmounted meanwhile (below), and coming
  // back to it (web history's Back over the picker) opens the picker again.
  const profilesHydrated = useProfiles((s) => s.hydrated);
  const choose = useMustChoose();
  const focused = useIsFocused();
  useEffect(() => {
    if (status !== 'authenticated' || !profilesHydrated) return;
    if (choose) {
      // This picker is the launch's question too: not asked again once answered.
      takeLaunchDecision();
      if (focused && !pickerOnTop()) openProfiles();
      return;
    }
    if (!takeLaunchDecision()) return;
    // Already open (a cold load of /profiles itself): that is this launch's question.
    if (asksAtLaunch(useProfiles.getState()) && !pickerOnTop()) openProfiles();
  }, [status, profilesHydrated, choose, focused]);

  // Web: the first screen's answers, asked as the gate opens and waited for a moment, so
  // the screen renders once with them rather than as a skeleton first (`use-startup-queries`;
  // always ready on native).
  const open = status === 'authenticated' && profilesHydrated && !choose && !kids;
  const ready = useStartupQueries(open);

  // A book link opened signed out comes back to that book after sign-in (frontend#129).
  if (status === 'unauthenticated') return <Redirect href={signedOutHref()} />;
  // A spinner while the session loads; and the profiles too (Phase 8): the shell must not
  // mount for a moment as the wrong person (or as a kids profile's grown-up tabs) before
  // they have loaded, nor at all while nobody is chosen (no one's pages, not even the last
  // person's, behind the picker). A kids profile never gets the shell (tabs, search,
  // settings, downloads, the web command palette): the root layout's `KidsRouteGuard`
  // takes it to `/kids`, and this holds the screen until it has. On the web, also the
  // moment the first screen's answers take (`ready`).
  if (status === 'loading' || !profilesHydrated || choose || kids || !ready) {
    return (
      <Screen>
        <Spinner center />
      </Screen>
    );
  }
  return <>{children}</>;
}
