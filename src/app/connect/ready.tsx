import { useLocalSearchParams } from 'expo-router';

import { ConnectionScope } from '@/api/provider';
import { ReadyScreen } from '@/components/connect/ready-screen';
import { LeaveOnboarding } from '@/components/shell/leave-onboarding';
import { useSession } from '@/stores/session';

/**
 * `/connect/ready?connection=<cid>`: "Your library is ready.", the end of the device's
 * first sign-in (`finishConnect`). Scoped to the new connection. Without one (an old
 * link, a removed server) it goes straight to the app.
 */
export default function ReadyRoute() {
  const { connection } = useLocalSearchParams<{ connection?: string }>();
  const conn = useSession((s) => s.connections.find((c) => c.id === connection));
  if (!conn) return <LeaveOnboarding />;
  return (
    <ConnectionScope connectionId={conn.id}>
      <ReadyScreen connectionId={conn.id} name={conn.name} addresses={conn.addresses} />
    </ConnectionScope>
  );
}
