import { Redirect, Slot } from 'expo-router';
import { useEffect } from 'react';

import { useOptionalApi } from '@/api/provider';
import { AppShell } from '@/components/layout/app-shell';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { useSession } from '@/stores/session';

export default function AppGroupLayout() {
  const status = useSession((s) => s.status);
  const setUser = useSession((s) => s.setUser);
  const api = useOptionalApi();

  // Refresh the cached user once authenticated so account flags
  // (has_password/has_recovery, role) are current — a session persisted before
  // these flags existed would otherwise mis-drive the sign-out recovery warning.
  // Best-effort: real auth failures are surfaced by the regular request flows.
  useEffect(() => {
    if (status !== 'authenticated' || !api) return;
    let cancelled = false;
    api
      .me()
      .then((u) => {
        if (!cancelled) void setUser(u);
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
