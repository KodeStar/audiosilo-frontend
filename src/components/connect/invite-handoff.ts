import { router } from 'expo-router';

import type { InviteScan } from '@/lib/pairing';
import { sameUrl } from '@/lib/server-address';
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

/** The connection the scanner was opened to re-pair (memory only). */
let scanFor: string | undefined;

/**
 * Open the QR scanner (`/connect/scan`). `reconnectId`: the connection the reconnect's
 * sign-in step it is opened from re-pairs. In memory, never in the scanner's params, for
 * the reason `holdScanReconnect` gives: a link opens that route too
 * (`audiosilo://connect/scan`), and a link must not name a connection to re-pair. Every way
 * into the scanner comes through here, so one that names no reconnect clears what an
 * earlier one left.
 */
export function openScanner(reconnectId?: string): void {
  scanFor = reconnectId;
  router.push('/connect/scan');
}

/** The reconnect the scanner was opened for (`openScanner`), taken once as it opens: a
 * scanner a link opened finds none. */
export function takeScanFor(): string | undefined {
  const id = scanFor;
  scanFor = undefined;
  return id;
}

/** The reconnect a scanned pairing code continues (memory only), by the code's token. */
let scanned: { token: string; reconnectId: string } | null = null;

/**
 * A pairing QR scanned from a reconnect's sign-in step ("No password? Scan a QR code
 * instead"): the scanner replaces itself with a new `/connect`, which must still know the
 * connection it re-pairs (`finishConnect`'s `reconnectId`: a server that was reset keeps
 * its person only through it). In memory and by the code's token, never in `/connect`'s
 * params: a link opens that route, and a link must not name a connection to re-pair.
 */
export function holdScanReconnect(token: string, reconnectId: string): void {
  scanned = { token, reconnectId };
}

/** The reconnect held for the pairing code `token`, taken once. */
export function takeScanReconnect(token: string): string | undefined {
  const id = scanned?.token === token ? scanned.reconnectId : undefined;
  scanned = null;
  return id;
}

/** The reconnect the sign-in step for `server` re-pairs (memory only). */
let reconnecting: { server: string; reconnectId: string } | null = null;

/**
 * Open the sign-in step to re-pair the connection `reconnectId` through `server` (the
 * reconnect banner, a scanned code that continues a reconnect: fe#298). In memory and by
 * the server it signs in through, never in the sign-in step's params: a link opens that
 * route (`audiosilo://connect/sign-in?reconnect=`), and a link must not name the connection
 * a sign-in replaces. `server` must already be the pending one.
 */
export function holdReconnect(server: string, reconnectId: string): void {
  reconnecting = { server, reconnectId };
}

/** The reconnect held for the sign-in step at `server`, taken once as the step opens: a
 * sign-in step a link opened, or one for another server, finds none. */
export function takeReconnect(server: string): string | undefined {
  const id =
    reconnecting && sameUrl(reconnecting.server, server) ? reconnecting.reconnectId : undefined;
  reconnecting = null;
  return id;
}

/** The connect flow was left (its layout's cleanup): a reconnect a scanner or the sign-in
 * step was opened for, or a scanned code held, and nothing took, goes with it, so none
 * waits for a later flow (a scanner or a sign-in step a link opens, the same code again). */
export function dropConnectHandoffs(): void {
  scanFor = undefined;
  scanned = null;
  reconnecting = null;
}
