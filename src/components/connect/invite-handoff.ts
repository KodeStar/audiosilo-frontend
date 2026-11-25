import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import type { InviteScan } from '@/lib/pairing';
import { type ConnectBook, connectBookParams } from '@/lib/paths';
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
  // The sign-in route can still be loading when Connect is pressed again. One held
  // invite opens one step, which takes it on mount.
  if (peekInviteCode(invite.base) === invite.code) return;
  holdInvite(invite);
  void useSession
    .getState()
    .setPendingServerUrl(invite.base)
    .then(() => {
      if (held === invite) go();
    });
}

/**
 * A hand-off a screen reads as it renders (`peek`) and takes (`take`, given what was read)
 * only once it is on screen: a render can be thrown away and run again before it shows (the
 * web's route chunk still loading), and a take in that render would leave the screen that
 * shows without it. Every screen that takes a hand-off comes through here.
 */
export function useHandoff<T>(peek: () => T, take: (read: T) => void): T {
  const [read] = useState(peek);
  useEffect(() => {
    take(read);
    // Once, as the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return read;
}

/** The held invite code for `server` (the sign-in step's server), left held (`useHandoff`). */
export function peekInviteCode(server: string): string | undefined {
  return held && sameUrl(held.base, server) ? held.code : undefined;
}

/** The held invite code for `server`, taken once: a later visit to the sign-in step starts
 * with an empty field. `null`: a step with no server, which drops it. */
export function takeInviteCode(server: string | null): string | undefined {
  const code = server ? peekInviteCode(server) : undefined;
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
 * earlier one left. `book`: the book the sign-in step was heading to (a signed-out visit's),
 * in the scanner's params as a link carries it, so the scan still ends on it (fe#299).
 */
export function openScanner(reconnectId?: string, book?: ConnectBook): void {
  scanFor = reconnectId;
  router.push(
    book ? { pathname: '/connect/scan', params: connectBookParams(book) } : '/connect/scan',
  );
}

/** The reconnect the scanner was opened for, left held (`useHandoff`). */
export function peekScanFor(): string | undefined {
  return scanFor;
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

/** The reconnect held for the pairing code `token`, left held (`useHandoff`). */
export function peekScanReconnect(token: string): string | undefined {
  return scanned?.token === token ? scanned.reconnectId : undefined;
}

/** The reconnect held for the pairing code `token`, taken once. */
export function takeScanReconnect(token: string): string | undefined {
  const id = peekScanReconnect(token);
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

/** The reconnect held for the sign-in step at `server`, taken once as the step opens (one
 * with no server too, which goes back to the first step): a sign-in step a link opened, or
 * one for another server, finds none, and a later one in the same flow finds none either. */
export function takeReconnect(server: string | null): string | undefined {
  const id = peekReconnect(server);
  reconnecting = null;
  return id;
}

/** The reconnect held for the sign-in step at `server`, left held (`useHandoff`). */
export function peekReconnect(server: string | null): string | undefined {
  return reconnecting && server && sameUrl(reconnecting.server, server)
    ? reconnecting.reconnectId
    : undefined;
}

/** The connect flow was left (its layout's cleanup): a reconnect a scanner or the sign-in
 * step was opened for, a scanned code or an invite's code held, and nothing took, goes with
 * it, so none waits for a later flow (a scanner or a sign-in step a link opens, the same
 * code again). */
export function dropConnectHandoffs(): void {
  held = null;
  scanFor = undefined;
  scanned = null;
  reconnecting = null;
}
