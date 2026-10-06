import { Redirect } from 'expo-router';
import { useEffect, type ReactNode } from 'react';

import { useOptionalApi } from '@/api/provider';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { accountFlagsKnown } from '@/lib/account';
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

  if (status === 'loading') {
    return (
      <Screen>
        <Spinner center />
      </Screen>
    );
  }
  if (status === 'unauthenticated') return <Redirect href="/connect" />;
  return <>{children}</>;
}
