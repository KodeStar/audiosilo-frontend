import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ConnectionScope, useCid } from '@/api/provider';
import { OtherPersonGate } from '@/components/profiles/other-person-gate';
import { EmptyState } from '@/components/ui/empty-state';
import { Screen } from '@/components/ui/screen';
import { backOrHome } from '@/lib/back-or-home';
import { connectionParam } from '@/lib/paths';
import { useRouteParams } from '@/lib/route-params';
import { otherOwner, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

/**
 * Scopes a content screen's subtree to the connection carried by its OWN `?connection=`
 * query param, read via `useRouteParams` - the route that owns the param, so it is
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
 * flashed a blank page and jumped Home). A link with no `connection` scopes to the active
 * connection (`useRouteConnection`). Aggregated screens (Home/Search) carry no
 * `connection` and don't wrap in this: their scope is `''`.
 *
 * A connection of ANOTHER person on this device (Phase 8 profiles) is never shown
 * silently: `OtherPersonGate` offers to switch to them first (their PIN rules apply).
 */
export function ContentScope({ children }: { children: ReactNode }) {
  const { connection } = useRouteParams<{ connection?: string | string[] }>();
  const { cid, gate } = useRouteConnection(connection);
  return gate ?? <ConnectionScope connectionId={cid}>{children}</ConnectionScope>;
}

/**
 * The rule every route that carries `?connection=` follows, in one place: the content
 * screens through `ContentScope`, and the root modals (the player, the end credits, the
 * reader, the Year in listening story), which sit outside any scope, directly. The param
 * is read through `connectionParam` (an old id a widget or a car snapshot carries
 * resolves); `named` is that id, '' when the link names none. `cid` is the connection the
 * screen shows: the named one, else the active connection (`useCid`), so a link with no
 * `connection=` (a hand-edited or old one) keys its downloads, places and requests by a
 * real connection, never by '' (fe#296, fe#172). `gate` is what to show instead of the
 * screen: a not-found state for a named connection that isn't signed in,
 * `OtherPersonGate` for another person's (switch first, their PIN rules apply). Null when
 * the screen may show.
 */
export function useRouteConnection(connection: string | string[] | undefined): {
  cid: string;
  named: string;
  gate: ReactElement | null;
} {
  const named = connectionParam(connection);
  const cid = useCid(named || undefined);
  const known = useSession((s) => !named || s.connections.some((c) => c.id === named));
  const owner = useProfiles((s) => otherOwner(s, named));
  const gate = !known ? <UnknownConnection /> : owner ? <OtherPersonGate profile={owner} /> : null;
  return { cid, named, gate };
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
          onPress: backOrHome,
        }}
      />
    </Screen>
  );
}
