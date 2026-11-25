import type { TFunction } from 'i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import {
  ApiError,
  LegacyExchangeUnansweredError,
  isProxyRefusal,
  isRefusedForGood,
  isSignedOutError,
} from '@/api/client';
import { connectClientFor } from '@/api/connect-client';
import { resolveClient } from '@/api/connection-clients';
import { probeServerId } from '@/api/server-id-probe';
import { connectForNewProfile } from '@/components/profiles/connect-intent';
import { getDeviceName } from '@/lib/device';
import type { PairingScan } from '@/lib/pairing';
import { getSignInKey } from '@/lib/sign-in-key';
import { useLatest } from '@/lib/use-latest';
import { sessionHydrateFailed, useSession } from '@/stores/session';

import { pairingFallback, selfSignedMayBeWhy, signedInAs } from './connect-model';
import { endConnect, finishConnect } from './finish-connect';
import { refusalWaitOver, sharedRefusalText, type WaitOver } from './sign-in-error';
import { useRefusalError } from './use-refusal-error';

/** How a pairing link's exchange ended. `refused`: the server said no for good (any 4xx
 * but 408 and 429, or a token spent on an exchange whose session this device then
 * couldn't keep), so the link is dead. `temporary`: the server timed out (408), was busy
 * (429), failed itself (5xx) or didn't answer, so the same link can work later (a reload
 * tries it again). Also `temporary` once the screen has gone (`pairFailure`). */
export type PairOutcome = 'paired' | 'refused' | 'temporary';

/** Why a pairing link failed: what it means for the link (`PairOutcome`) and the words
 * the screen says, from ONE reading of the error so the two never disagree, with what
 * they become once a 429's wait is over (`refusalWaitOver`). */
export type PairFailure = {
  outcome: 'refused' | 'temporary';
  message: string;
  waitOver?: WaitOver;
};

/**
 * A failed exchange (`e`), in words of our own, never the server's English:
 * - after the exchange (`exchanged`: the token is spent, storing the session failed):
 *   refused, ask for a new link;
 * - no answer: temporary, naming a self-signed certificate only where one may be why
 *   (`selfSigned`, `selfSignedMayBeWhy`);
 * - 408, 429 (the wait from `Retry-After` when sent, `sharedRefusalText`), a proxy's own 401
 *   or 403 (`isProxyRefusal`: its headers, `sharedRefusalText`) and 5xx: temporary;
 * - every other 4xx: refused, by the server's code when it names one (`invite_used`,
 *   `invite_expired`, `member_disabled`), else expired or used (401, 410), else a link
 *   that can't be used.
 */
export function pairFailure(
  e: unknown,
  exchanged: boolean,
  selfSigned: boolean,
  t: TFunction,
): PairFailure {
  const refused = (message: string): PairFailure => ({ outcome: 'refused', message });
  const temporary = (message: string): PairFailure => ({ outcome: 'temporary', message });
  if (e instanceof LegacyExchangeUnansweredError)
    return refused(t('connect.signIn.errors.inviteMayBeUsedByThisDevice'));
  if (exchanged) return refused(t('connect.server.pairingSpent'));
  if (!(e instanceof ApiError)) {
    return temporary(
      selfSigned
        ? t('connect.server.pairingReachSelfSigned')
        : t('connect.server.pairingReachError'),
    );
  }
  const { status } = e;
  // Not refused for good (the rule every save queue keeps): a 408, a 429 (its shared words
  // name the wait), a proxy's own 401 or 403 (its shared words name the proxy headers, never
  // the server) or no 4xx at all.
  if (!isRefusedForGood(e)) {
    if (status === 408) return temporary(t('connect.server.pairingReachError'));
    const shared = status === 429 || isProxyRefusal(e) ? sharedRefusalText(e, t) : undefined;
    if (shared !== undefined) return { ...temporary(shared), waitOver: refusalWaitOver(e, t) };
    return temporary(t('connect.server.pairingServerError'));
  }
  return refused(
    sharedRefusalText(e, t) ??
      (status === 401 || status === 410
        ? t('connect.server.pairingRefused')
        : t('connect.server.pairingUnusable')),
  );
}

export type LinkPairing = {
  /** A pairing token is being exchanged. */
  pairing: boolean;
  /** Why the last pairing failed, in words. */
  error: string | null;
  /** Say why a link can't pair (a link with no server address), or a single sign-on's
   * finish failed, with what the words become once a wait they name is over. */
  fail: (message: string, waitOver?: WaitOver) => void;
  /** Put away why the last pairing failed (the listener moved on to another address). */
  clear: () => void;
  /** Exchange a pairing link's token on its server and finish the connect flow (on the
   * link's book, when it names one). Resolves how it ended (`PairOutcome`). `reconnectId`:
   * the connection a code scanned from a reconnect's sign-in step re-pairs
   * (`scanReconnect`); never a link's to name. */
  pair: (scan: PairingScan, reconnectId?: string) => Promise<PairOutcome>;
};

/** Keep a retry on the address and device key of the exchange whose answer may be lost. */
type LinkExchange = {
  scan: PairingScan;
  address: string;
  legacyError?: LegacyExchangeUnansweredError;
};

/**
 * Whether the server still takes the stored token of `connectionId` (`GET /me` through the
 * connection's own client, which flags a refused one for reconnect). `needsReconnect` is
 * in memory only, so a fresh tab (the console's "Listen in player" always opens one) can't
 * tell a revoked token from a good one without asking. Only the server's own 401 says no
 * (`isSignedOutError`): a server that doesn't answer, or a proxy in front of it turning the
 * request away (`ApiError.fromProxy`: the token was never judged, and a new exchange would
 * meet the same proxy), leaves the book to open as it would offline. Never through the link's
 * base: a link can name any address, and the stored token goes only where it always has.
 */
async function stillSignedIn(connectionId: string): Promise<boolean> {
  const client = resolveClient(connectionId);
  if (!client) return false;
  try {
    await client.me();
    return true;
  } catch (e) {
    return !isSignedOutError(e);
  }
}

/**
 * Pairing by link (a pairing QR, an invite link, a pasted link, a deep link): exchange
 * the link's token on the link's server for a session, after reading the server's own name and
 * whether it marks every 401, then `finishConnect` (which
 * merges the link's addresses with the answer's). When the link's https base can't be
 * reached (a self-signed certificate the device can't trust), the exchange goes once to
 * the link's plain-http home address on the same host and port, only when home answers as
 * the server the link names (`pairingFallback`), and the session must come from that
 * server too. The connection is still stored with the https base (which fails safely by
 * TLS on another network, where a plain-http address could be another box), with home as
 * its first address pick (`answeredAt`). A link naming a book ends on it, and skips the
 * exchange when the device is already signed in as the link's user there (its token still
 * taken, `stillSignedIn`). Resolves how it ended (`PairOutcome`). Bare client: a failed
 * exchange must never flag a reconnect. A code scanned from a reconnect's sign-in step
 * pairs as that step's own sign-in does (`reconnectId`): with the connection's own proxy
 * headers only, and `finishConnect` told which connection it re-pairs.
 */
export function useLinkPairing(startPairing = false): LinkPairing {
  const { t } = useTranslation();
  const [pairing, setPairing] = useState(startPairing);
  const [error, setError] = useRefusalError();
  const live = useRef(true);
  const lastExchange = useRef<LinkExchange | null>(null);
  const pairingRequests = useRef(new Map<string, Promise<PairOutcome>>());
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Stable (`useLatest`): the deep link's effect lists it, and a language switch must not
  // run the exchange again.
  const pairOnce = useLatest(
    async (scan: PairingScan, reconnectId?: string): Promise<PairOutcome> => {
      setError(null);
      setPairing(true);
      // A link naming a book, for a user this device is already signed in as on its server
      // (the console's "Listen in player": `signedInAs`) with a token the server still takes
      // (`stillSignedIn`): the book opens with no exchange, and the unused token expires by
      // itself (no second session, no "new device" notice). Not for "Add someone": the
      // exchange's `finishConnect` switches to that person.
      if (scan.book && scan.userId && scan.serverId && !connectForNewProfile()) {
        // The connections first, when they never loaded (as `finishConnect` reads them).
        if (sessionHydrateFailed()) await useSession.getState().hydrate();
        const signedIn = signedInAs(useSession.getState().connections, scan.serverId, scan.userId);
        if (signedIn && (await stillSignedIn(signedIn.id))) {
          if (!live.current) return 'temporary';
          endConnect(signedIn.id, scan.book);
          return 'paired';
        }
        if (!live.current) return 'temporary';
      }
      // Read the mark at the address about to receive the token. Pick a verified home
      // fallback during discovery: once a POST goes out, switching addresses could spend
      // another use with the sign-in key for that other address.
      const readServer = async (base: string) => {
        let marks: boolean | undefined;
        const { client, proxy } = connectClientFor(base, undefined, () => marks);
        try {
          const info = await client.serverInfo();
          marks = info.capabilities?.unauthorized_mark;
          return { client, proxy, info, error: null };
        } catch (error) {
          return { client, proxy, info: null, error };
        }
      };
      const last = lastExchange.current;
      let attempt = last?.scan.token === scan.token && last.scan.base === scan.base ? last : null;
      let exchanged = false;
      try {
        if (attempt?.legacyError) throw attempt.legacyError;
        let answeredAt = attempt?.address ?? scan.base;
        let target = await readServer(answeredAt);
        if (
          !attempt &&
          live.current &&
          target.error &&
          !(target.error instanceof ApiError) &&
          Platform.OS !== 'web'
        ) {
          let askedHome = false;
          const home = await pairingFallback(scan, target.error, (base) => {
            askedHome = true;
            return probeServerId(base);
          });
          // Neither address answered as the link's server. Leave the choice open for Retry.
          if (askedHome && !home) throw target.error;
          if (home && live.current) {
            answeredAt = home;
            target = await readServer(home);
          }
        }
        const { client, proxy: carried, info } = target;
        const homeServer = (attempt?.scan ?? scan).serverId;
        if (answeredAt !== scan.base && (!homeServer || info?.server_id !== homeServer)) {
          throw new Error('home did not confirm the server in the pairing link');
        }
        const deviceId = await getSignInKey(answeredAt);
        if (!live.current) return 'temporary';
        attempt ??= { scan, address: answeredAt };
        lastExchange.current = attempt;
        const session = await client.exchange(scan.token, getDeviceName(), deviceId);
        if (answeredAt !== scan.base && session.server_id !== homeServer) {
          throw new Error('another server answered at home');
        }
        exchanged = true;
        if (!live.current) return 'temporary';
        await finishConnect({
          serverUrl: scan.base,
          session,
          linkAddresses: scan.addresses,
          name: info?.name,
          ...(answeredAt !== scan.base ? { answeredAt } : {}),
          ...(reconnectId ? { reconnectId } : {}),
          book: scan.book,
          carried,
        });
        return 'paired';
      } catch (e) {
        if (attempt && e instanceof LegacyExchangeUnansweredError) attempt.legacyError = e;
        if (!live.current) return 'temporary';
        const failure = pairFailure(
          e,
          exchanged,
          selfSignedMayBeWhy(scan.base, e, Platform.OS === 'web'),
          t,
        );
        setError(failure.message, failure.waitOver);
        setPairing(false);
        return failure.outcome;
      }
    },
  );

  // A repeated link effect or a double press joins the exchange already spending this
  // token. Both callers learn its outcome, and only one stores the resulting session.
  const pair = useCallback(
    (scan: PairingScan, reconnectId?: string) => {
      const key = JSON.stringify([scan.base, scan.token, reconnectId]);
      const pending = pairingRequests.current.get(key);
      if (pending) return pending;
      const request = pairOnce(scan, reconnectId).finally(() => {
        pairingRequests.current.delete(key);
      });
      pairingRequests.current.set(key, request);
      return request;
    },
    [pairOnce],
  );

  const fail = useLatest((message: string, waitOver?: WaitOver) => {
    setError(message, waitOver);
    setPairing(false);
  });

  const clear = useCallback(() => setError(null), [setError]);

  return { pairing, error, fail, pair, clear };
}
