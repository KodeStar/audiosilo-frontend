import { Redirect, Slot, useGlobalSearchParams } from 'expo-router';
import { useEffect, type ReactNode } from 'react';

import { ConnectionScope, useOptionalApi } from '@/api/provider';
import { AppShell } from '@/components/layout/app-shell';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { accountFlagsKnown } from '@/lib/recovery';
import { useSession } from '@/stores/session';

/**
 * Publishes the `?connection=` query param (carried by every content link - see
 * `paths.ts`) as the connection scope for the screens under it, so a book/library/
 * account resolves to *that* server's hooks rather than the default connection.
 * Content routes are flat with the connection in the query (not a `/s/[connectionId]/`
 * segment) because `router.push` can't resolve a tap into a route nested under a
 * dynamic layout. Aggregated screens (Home/Search) carry no `connection`, so the scope
 * is '' and they use the default. Redirects home if the id isn't a known connection, so
 * `useApi()` under the scope never throws on a stale link to a removed/unpaired server.
 */
function ContentScope({ children }: { children: ReactNode }) {
  const { connection } = useGlobalSearchParams<{ connection?: string | string[] }>();
  const cid = Array.isArray(connection) ? (connection[0] ?? '') : (connection ?? '');
  const known = useSession((s) => !cid || s.connections.some((c) => c.id === cid));
  if (!known) return <Redirect href="/" />;
  return <ConnectionScope connectionId={cid}>{children}</ConnectionScope>;
}

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
      <ContentScope>
        <Slot />
      </ContentScope>
    </AppShell>
  );
}
