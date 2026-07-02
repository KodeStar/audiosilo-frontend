import { Redirect, Slot } from 'expo-router';
import { useEffect } from 'react';

import { useOptionalApi } from '@/api/provider';
import { AppShell } from '@/components/layout/app-shell';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { accountFlagsKnown } from '@/lib/recovery';
import { useSession } from '@/stores/session';

export default function AppGroupLayout() {
  const status = useSession((s) => s.status);
  const setUser = useSession((s) => s.setUser);
  const api = useOptionalApi();

  // Backfill the cached user's account flags (has_password/has_recovery) for a
  // session persisted before those flags existed - fresh logins already carry
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
  if (status === 'unauthenticated') {
    return <Redirect href="/connect" />;
  }

  return (
    <AppShell>
      <Slot />
    </AppShell>
  );
}
