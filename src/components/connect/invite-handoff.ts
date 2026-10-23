import type { InviteScan } from '@/lib/pairing';
import { useSession } from '@/stores/session';

/** The invite a scan or a pasted link is handing to the sign-in step (memory only). */
let held: InviteScan | null = null;

/**
 * Hand an invite link's code to the sign-in step (#98: a scanned or pasted invite signs in
 * in one step). In memory, never in the route: a code in the address would stay in the
 * browser's history.
 */
export function holdInvite(invite: InviteScan): void {
  held = invite;
}

/** Start an invite's sign-in (a scanned QR or a pasted link): hold its code, make its
 * server the pending one, then `go` to the sign-in step. */
export function beginInviteSignIn(invite: InviteScan, go: () => void): void {
  holdInvite(invite);
  void useSession.getState().setPendingServerUrl(invite.base).then(go);
}

/** The held invite code for `server` (the sign-in step's server), taken once: a later
 * visit to the sign-in step starts with an empty field. */
export function takeInviteCode(server: string): string | undefined {
  const code = held?.base === server ? held.code : undefined;
  held = null;
  return code;
}
