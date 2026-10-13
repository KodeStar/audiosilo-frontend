import type { AuthSession } from '@/api/types';
import { mayAddPerson } from '@/components/profiles/connect-intent';
import i18n from '@/i18n';
import { priorConnection, serverIdOf } from '@/lib/connection-id';
import {
  activeProfile,
  DEFAULT_BEDTIME,
  placeConnection,
  setProfileKids,
  useProfiles,
} from '@/stores/profiles';
import { type Connection, sessionHydrateFailed, useSession } from '@/stores/session';

/** Why `addMemberHere` refused. `already_here`: this device already holds a connection for
 * that user on that server (signing them in again would replace it, PIN and all). */
export class AddMemberHereError extends Error {
  readonly code = 'already_here' as const;

  constructor() {
    super(i18n.t('connect.memberAlreadyHere'));
    this.name = 'AddMemberHereError';
  }
}

/**
 * Whether this device already holds a connection for user `userId` on the server
 * `serverId` (or one from before Phase 8 that can't tell its users apart,
 * `priorConnection`). Ask before minting a member's session (`memberSession`): a session
 * `addMemberHere` then refuses would stay signed in on the server with nothing using it.
 */
export function memberSignedInHere(serverId: string, userId: number): boolean {
  return priorConnection(useSession.getState().connections, serverId, userId) !== undefined;
}

/** The owner's connection to `serverId`: the person listening's (who added the member),
 * else the default connection when it is on that server, else any. */
function ownerConnection(connections: readonly Connection[], serverId: string) {
  const onServer = connections.filter((c) => serverIdOf(c) === serverId);
  const mine = activeProfile()?.connectionIds ?? [];
  const def = useSession.getState().defaultConnectionId;
  return (
    onServer.find((c) => mine.includes(c.id)) ??
    onServer.find((c) => c.id === def) ??
    onServer[0] ??
    null
  );
}

/**
 * Sign a household member in on THIS device, beside the owner (Phase 8b-1: a kid added in
 * the Household page, `addMember({ sign_in_here: true })`'s session, or a grown-up's
 * "They'll also use this phone", `memberSession`). A variant of `finishConnect` that
 * leaves the owner where they are:
 *
 * - the member's connection is stored with the owner's address and server name (the
 *   member is on the owner's server), and both connections learn the addresses the answer
 *   carried (`learnAddresses`, `setSession`'s merge);
 * - the default connection does not move (`setSession(..., { makeDefault: false })`);
 * - the member gets a profile of their own named `opts.name`, and the owner stays the
 *   active person (`placeConnection(..., { newProfile: true, keepActive: true })`): never
 *   `switchProfile`, so the owner's book plays on;
 * - a kid (`opts.kids`) starts in kids mode (the first library the account lists, the
 *   default bedtime), allowed whatever else is on the device (`mayTurnOnKids`).
 *
 * Refuses, changing nothing, with `AddMemberHereError` (`already_here`) when the device
 * already holds that user on that server (`memberSignedInHere`), and with an `Error` when
 * the person listening is in kids mode with a grown-up on the device (`mayAddPerson`),
 * when the profiles can't be read, or when the device has no connection to that server.
 * Resolves to the new connection's and profile's ids. No navigation: the caller stays on
 * its own screen.
 */
export async function addMemberHere(
  session: AuthSession,
  opts: { name: string; kids: boolean },
): Promise<{ connectionId: string; profileId: string }> {
  // The connections first, when they never loaded (as `finishConnect`): the duplicate
  // check and the owner's connection are read from them.
  if (sessionHydrateFailed()) await useSession.getState().hydrate();
  const profiles = useProfiles.getState();
  if (!profiles.hydrated || profiles.hydrationFailed) {
    throw new Error(i18n.t('connect.memberNotReady'));
  }
  if (!mayAddPerson()) throw new Error(i18n.t('profiles.add.chooseAdult'));
  const serverId = session.server_id;
  const { connections, learnAddresses, setSession } = useSession.getState();
  if (priorConnection(connections, serverId, session.user.id)) throw new AddMemberHereError();
  const owner = ownerConnection(connections, serverId);
  if (!owner) throw new Error(i18n.t('connect.memberNotReady'));
  // The addresses are the server's (the answer was read through the owner's client): the
  // owner's connection learns them too, as a pairing would teach it.
  await learnAddresses(owner.id, session.addresses);
  const id = await setSession(
    {
      serverUrl: owner.serverUrl,
      serverId,
      token: session.token,
      user: session.user,
      name: owner.name,
      addresses: session.addresses,
    },
    { makeDefault: false },
  );
  const profileId = placeConnection(id, { newProfile: true, keepActive: true, name: opts.name });
  if (!profileId) throw new Error(i18n.t('connect.memberNotReady'));
  if (opts.kids) setProfileKids(profileId, { bedtime: DEFAULT_BEDTIME });
  return { connectionId: id, profileId };
}
