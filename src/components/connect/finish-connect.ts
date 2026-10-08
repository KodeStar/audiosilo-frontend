import { router } from 'expo-router';

import type { AuthSession, ServerAddresses } from '@/api/types';
import { leaveOnboarding } from '@/components/shell/leave-onboarding';
import { useSession } from '@/stores/session';

import { isFirstConnection, repairPlan } from './connect-model';

/** The "Your library is ready." route for a connection. */
export function readyHref(connectionId: string) {
  return { pathname: '/connect/ready', params: { connection: connectionId } } as const;
}

/**
 * The end of every way into a server (a pairing link or QR, an invite code, a password,
 * the demo): store the connection, then show "Your library is ready." when it is the
 * device's first, else go straight back to the app (`leaveOnboarding`).
 *
 * `serverUrl` is the address signed in through; `repairPlan` decides what is stored (a
 * re-pair of a known connection keeps the address it was paired with). `addresses` is
 * what the link and the answer taught (`pairingAddresses`). `name` is the server's own
 * name when the flow knows it (the probe, the redeem payload), so a connection made by a
 * link is not named after its host. `reconnectId` is the connection the reconnect banner
 * started this for.
 */
export async function finishConnect(input: {
  serverUrl: string;
  session: AuthSession;
  addresses?: ServerAddresses;
  name?: string;
  reconnectId?: string;
}): Promise<string> {
  const { connections, setSession } = useSession.getState();
  const first = isFirstConnection(connections);
  const plan = repairPlan({
    pending: input.serverUrl,
    serverId: input.session.server_id,
    connections,
    reconnectId: input.reconnectId,
    answer: input.addresses,
  });
  const id = await setSession({
    serverUrl: plan.serverUrl,
    serverId: input.session.server_id,
    token: input.session.token,
    user: input.session.user,
    ...(input.name ? { name: input.name } : {}),
    ...(plan.addresses ? { addresses: plan.addresses } : {}),
  });
  if (first) router.replace(readyHref(id));
  else leaveOnboarding();
  return id;
}
