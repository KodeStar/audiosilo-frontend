import { router, useLocalSearchParams } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ConnectionScope } from '@/api/provider';
import { OtherPersonGate } from '@/components/profiles/other-person-gate';
import { otherOwner } from '@/components/profiles/profiles-model';
import { EmptyState } from '@/components/ui/empty-state';
import { Screen } from '@/components/ui/screen';
import { connectionParam } from '@/lib/paths';
import { useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

/**
 * Scopes a content screen's subtree to the connection carried by its OWN `?connection=`
 * query param, read via `useLocalSearchParams` - the route that owns the param, so it is
 * populated from the screen's first render.
 *
 * It must NOT be sourced from the `(app)` layout via `useGlobalSearchParams` (the shape
 * this replaced): a layout can't read a child route's params any other way, but on a
 * cold/direct deep link (`/book/5?connection=c2`) the global param lags for the first
 * render(s). During that window the scope resolves to `''` -> the DEFAULT connection, so
 * the screen and its hooks fetch the wrong server's `libraryId 5` and seed the React
 * Query cache under the wrong connection id until the param settles. Reading the local
 * param (like `player.tsx` already does) is correct from the first render.
 *
 * A connection that isn't signed in (a stale link to a removed or unpaired server, a
 * removed person's book) gets a not-found state with a way back, never the children, so
 * `useApi()` under the scope never throws. Never a `<Redirect>`: the page stays in its tab
 * stack, and a redirect there fires again on every focus of the tab (each tap on the tab
 * flashed a blank page and jumped Home). Aggregated screens (Home/Search) carry no
 * `connection`, so they don't wrap in this and default to `''`.
 *
 * A connection of ANOTHER person on this device (Phase 8 profiles) is never shown
 * silently: `OtherPersonGate` offers to switch to them first (their PIN rules apply).
 */
export function ContentScope({ children }: { children: ReactNode }) {
  const { connection } = useLocalSearchParams<{ connection?: string | string[] }>();
  const cid = connectionParam(connection);
  const known = useSession((s) => !cid || s.connections.some((c) => c.id === cid));
  const owner = useProfiles((s) => otherOwner(s, cid));
  if (!known) return <UnknownConnection />;
  if (owner) return <OtherPersonGate profile={owner} />;
  return <ConnectionScope connectionId={cid}>{children}</ConnectionScope>;
}

function UnknownConnection() {
  const { t } = useTranslation();
  return (
    <Screen testID="unknown-connection">
      <EmptyState
        className="flex-1"
        icon="server"
        title={t('shell.unknownConnection.title')}
        hint={t('shell.unknownConnection.hint')}
        action={{
          label: t('shell.unknownConnection.back'),
          onPress: () => (router.canGoBack() ? router.back() : router.dismissTo('/')),
        }}
      />
    </Screen>
  );
}
