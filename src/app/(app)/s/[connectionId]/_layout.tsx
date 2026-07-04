import { Redirect, Slot, useLocalSearchParams } from 'expo-router';

import { ConnectionScope } from '@/api/provider';
import { useSession } from '@/stores/session';

/**
 * Scope layout for the connection-in-route content group (`/s/<connectionId>/…`).
 * It publishes the route's connection to the content hooks underneath (so a library
 * or book resolves to *that* server rather than the global "active" one), and
 * redirects home if the id isn't a currently-known connection - so `useApi()` inside
 * the scope never throws on a stale link to a removed/unpaired server.
 */
export default function ConnectionScopeLayout() {
  const { connectionId } = useLocalSearchParams<{ connectionId: string }>();
  const known = useSession((s) => s.connections.some((c) => c.id === connectionId));
  if (!connectionId || !known) return <Redirect href="/" />;
  return (
    <ConnectionScope connectionId={connectionId}>
      <Slot />
    </ConnectionScope>
  );
}
