import { router } from 'expo-router';

import type { AuthSession, ServerAddresses } from '@/api/types';
import { connectForNewProfile } from '@/components/profiles/connect-intent';
import { leaveOnboarding } from '@/components/shell/leave-onboarding';
import { serverIdOf } from '@/lib/connection-id';
import { list as listKnownServers } from '@/lib/known-servers';
import { mergeAddresses } from '@/lib/server-address';
import { activeProfile, placeConnection, profileOf, switchProfile } from '@/stores/profiles';
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
    userId: input.session.user.id,
  });
  const newPerson = connectForNewProfile();
  // A connection the device already had (a re-pair) keeps its person; read before the
  // session adds a new one (the profiles reconcile places it at once).
  const sameServer = connections.filter((c) => serverIdOf(c) === serverId);
  const existing =
    sameServer.find((c) => c.user?.id === input.session.user.id) ??
    sameServer.find((c) => typeof c.user?.id !== 'number');
  const hadProfile = existing ? profileOf(existing.id) : null;
  const id = await setSession({
    serverUrl: plan.serverUrl,
    serverId,
    token: input.session.token,
    user: input.session.user,
    ...(input.name ? { name: input.name } : {}),
    addresses: plan.addresses,
  });
  await placeSignedIn(id, hadProfile?.id ?? null, newPerson);
  if (first) router.replace(readyHref(id));
  else leaveOnboarding();
  return id;
}

/**
 * The profile the connection just signed in belongs to (Phase 8, `src/stores/profiles.ts`):
 * - a NEW connection goes into the active profile, unless that profile already has this
 *   server (another user on it is another person) or the flow was "Add someone": then a
 *   profile of its own, which becomes active (`placeConnection`);
 * - a re-pair keeps the person it had; "Add someone" signing in as a person already on
 *   this device switches to them.
 * A change of person goes through `switchProfile` (the previous person's book unloads).
 */
async function placeSignedIn(
  id: string,
  hadProfileId: string | null,
  newPerson: boolean,
): Promise<void> {
  const before = activeProfile()?.id ?? null;
  const target = hadProfileId
    ? newPerson
      ? hadProfileId
      : null
    : placeConnection(id, { newProfile: newPerson });
  if (target && target !== before) await switchProfile(target);
}
