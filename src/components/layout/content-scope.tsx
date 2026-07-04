import { Redirect, useLocalSearchParams } from 'expo-router';
import type { ReactNode } from 'react';

import { ConnectionScope } from '@/api/provider';
import { connectionParam } from '@/lib/paths';
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
 * Redirects home when the id names a connection that isn't signed in, so `useApi()` under
 * the scope never throws on a stale link to a removed/unpaired server. Aggregated screens
 * (Home/Search) carry no `connection`, so they don't wrap in this and default to `''`.
 */
export function ContentScope({ children }: { children: ReactNode }) {
  const { connection } = useLocalSearchParams<{ connection?: string | string[] }>();
  const cid = connectionParam(connection);
  const known = useSession((s) => !cid || s.connections.some((c) => c.id === cid));
  if (!known) return <Redirect href="/" />;
  return <ConnectionScope connectionId={cid}>{children}</ConnectionScope>;
}
