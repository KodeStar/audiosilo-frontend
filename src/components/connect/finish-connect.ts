import { router } from 'expo-router';

import type { AuthSession, ServerAddresses } from '@/api/types';
import { leaveOnboarding } from '@/components/shell/leave-onboarding';
import { list as listKnownServers } from '@/lib/known-servers';
import { mergeAddresses } from '@/lib/server-address';
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
 * re-pair of a known connection keeps the address it was paired with). `linkAddresses`
 * is what the pairing link (`parsePairingScan`) or the redeem payload carried; merged
 * here with the session's own (`mergeAddresses`: the answer's `away` wins, a `home` only
 * the link knew is kept, since an answer read through the away address cannot know it).
 * Both arrive cleaned (the pairing parser, the client). `name` is the server's own
 * name when the flow knows it (the probe, the redeem payload), so a connection made by a
 * link is not named after its host. `reconnectId` is the connection the reconnect banner
 * started this for.
 */
export async function finishConnect(input: {
  serverUrl: string;
  session: AuthSession;
  linkAddresses?: ServerAddresses;
  name?: string;
  reconnectId?: string;
}): Promise<string> {
  const serverId = input.session.server_id;
  // The remembered server, for a sign-in again after signing out (`repairPlan`).
  const known = (await listKnownServers()).find((k) => k.serverId === serverId);
  const { connections, setSession } = useSession.getState();
  const first = isFirstConnection(connections);
  const plan = repairPlan({
    pending: input.serverUrl,
    serverId,
    connections,
    reconnectId: input.reconnectId,
    answer: mergeAddresses(input.linkAddresses, input.session.addresses),
    known,
  });
  const id = await setSession({
    serverUrl: plan.serverUrl,
    serverId,
    token: input.session.token,
    user: input.session.user,
    ...(input.name ? { name: input.name } : {}),
    addresses: plan.addresses,
  });
  if (first) router.replace(readyHref(id));
  else leaveOnboarding();
  return id;
}
