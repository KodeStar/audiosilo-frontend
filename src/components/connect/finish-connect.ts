import { router } from 'expo-router';

import type { AuthSession, ServerAddresses } from '@/api/types';
import { connectForNewProfile, mayAddPerson } from '@/components/profiles/connect-intent';
import { leaveOnboarding } from '@/components/shell/leave-onboarding';
import i18n from '@/i18n';
import { isKidAccount } from '@/lib/account';
import { priorConnection } from '@/lib/connection-id';
import { list as listKnownServers } from '@/lib/known-servers';
import { mergeAddresses } from '@/lib/server-address';
import {
  activeProfile,
  DEFAULT_BEDTIME,
  isKidsAccount,
  placeConnection,
  profileOf,
  setProfileKids,
  staleToRetire,
  switchProfile,
  useProfiles,
} from '@/stores/profiles';
import { sessionHydrateFailed, staleIdentities, useSession } from '@/stores/session';

import { isFirstConnection, repairPlan } from './connect-model';

/** The "Your library is ready." route for a connection. */
export function readyHref(connectionId: string) {
  return { pathname: '/connect/ready', params: { connection: connectionId } } as const;
}

/**
 * The end of every way into a server (a pairing link or QR, an invite code, a password,
 * the demo): store the connection, then show "Your library is ready." when it is the
 * device's first (not for a kid's account, which goes straight to kids mode), else go
 * straight back to the app (`leaveOnboarding`).
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
  // The connections first, when they never loaded (a failed session read leaves the
  // connect screen up): whose sign-in this is is read from them, and an unread list would
  // take a re-pair for a new connection (`placeConnection` would pull it out of its
  // person's profile, their PIN with it, into the one listening).
  if (sessionHydrateFailed()) await useSession.getState().hydrate();
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
  const existing = priorConnection(connections, serverId, input.session.user.id);
  // A server that was reset (another server_id at this address): only the stale identity
  // of the person signing in is retired, and the new connection takes its place in their
  // profile; anyone else's stays for them (`staleToRetire`).
  const retire = existing
    ? []
    : staleToRetire(
        staleIdentities(connections, serverId, plan.serverUrl).map((c) => c.id),
        useProfiles.getState(),
        { reconnectId: input.reconnectId, newPerson },
      );
  const replaced = retire[0];
  const hadProfile = existing
    ? profileOf(existing.id)
    : replaced !== undefined
      ? profileOf(replaced)
      : null;
  // Kids mode signs in again only as a connection this device has (a re-pair, or the
  // child's own identity on a server that was reset, keeps its person): anyone or anything
  // new would join or replace the child's profile without a grown-up (`mayAddPerson`;
  // "Who's listening?" disables "Add someone" the same way).
  if ((newPerson || (!existing && replaced === undefined)) && !mayAddPerson()) {
    throw new Error(i18n.t('profiles.add.chooseAdult'));
  }
  const id = await setSession({
    serverUrl: plan.serverUrl,
    serverId,
    token: input.session.token,
    user: input.session.user,
    ...(input.name ? { name: input.name } : {}),
    addresses: plan.addresses,
    retire,
  });
  await placeSignedIn(id, hadProfile?.id ?? null, newPerson);
  // A kid's account signed in for the first time on this device starts in kids mode (a
  // re-pair, or a sign-in again after a server reset, keeps what its person had).
  if (!existing && replaced === undefined) kidsOnForKidAccount(id);
  // "Your library is ready." is a grown-up's first run (8b-1, D9): a kid's account (or
  // anyone signing in while kids mode listens) goes straight to kids mode, which the
  // route guard takes on from Home.
  if (first && !activeProfile()?.kids) router.replace(readyHref(id));
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

/**
 * Kids mode on for a kid's account at its first placement on this device (Phase 8b-1: the
 * server says `user.member_kind === 'kid'`, a household member): the profile holding
 * `connectionId` turns kids mode on (the first library the account lists, the default
 * bedtime) when it has no kids settings yet and every account it holds is a kid's
 * (`isKidsAccount`: a grown-up's profile that a kid's sign-in joined is never put in kids
 * mode). Allowed with no grown-up on the device (`mayTurnOnKids`' exception: a kid's own
 * phone). A no-op for anyone else, and on a server without household members.
 */
export function kidsOnForKidAccount(connectionId: string): void {
  const { connections } = useSession.getState();
  const conn = connections.find((c) => c.id === connectionId);
  if (!isKidAccount(conn?.user)) return;
  const profile = profileOf(connectionId);
  if (!profile || profile.kids || !isKidsAccount(profile, connections)) return;
  setProfileKids(profile.id, { bedtime: DEFAULT_BEDTIME });
}
