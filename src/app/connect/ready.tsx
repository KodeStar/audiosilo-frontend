import { useLocalSearchParams } from 'expo-router';

import { ConnectionScope } from '@/api/provider';
import { ReadyScreen } from '@/components/connect/ready-screen';
import { useRouteConnection } from '@/components/layout/content-scope';
import { LeaveOnboarding } from '@/components/shell/leave-onboarding';
import { useSession } from '@/stores/session';

/**
 * `/connect/ready?connection=<cid>`: "Your library is ready.", the end of the device's
 * first sign-in (`finishConnect`). Scoped to the new connection. Without one (an old
 * link, a removed server) it goes straight to the app. Another person's connection follows
 * the route-connection rule (`useRouteConnection`): `OtherPersonGate`, never their library
 * and progress.
 */
export default function ReadyRoute() {
  const { connection } = useLocalSearchParams<{ connection?: string }>();
  const { cid, gate } = useRouteConnection(connection);
  const conn = useSession((s) => s.connections.find((c) => c.id === cid));
  if (!cid || !conn) return <LeaveOnboarding />;
  if (gate) return gate;
  return (
    <ConnectionScope connectionId={conn.id}>
      <ReadyScreen connectionId={conn.id} name={conn.name} addresses={conn.addresses} />
    </ConnectionScope>
  );
}
