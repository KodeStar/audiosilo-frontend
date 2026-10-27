import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import { ApiClient, ApiError, apiErrorKind } from '@/api/client';
import { resolveClient } from '@/api/connection-clients';
import { probeServerId } from '@/api/server-id-probe';
import { connectForNewProfile } from '@/components/profiles/connect-intent';
import { getDeviceName } from '@/lib/device';
import type { PairingScan } from '@/lib/pairing';
import { useLatest } from '@/lib/use-latest';
import { sessionHydrateFailed, useSession } from '@/stores/session';

import { pairingFallback, selfSignedMayBeWhy, signedInAs, withFallback } from './connect-model';
import { endConnect, finishConnect } from './finish-connect';

/** How a pairing link's exchange ended. `refused`: the server said no for good (the token
 * is expired, used up, unknown or malformed, or was spent on an exchange whose session
 * this device then couldn't keep), so the link is dead. `temporary`: the server was busy
 * (429), failed itself (5xx) or didn't answer, so the same link can work later (a reload
 * tries it again). Also `temporary` once the screen has gone. */
export type PairOutcome = 'paired' | 'refused' | 'temporary';

/** A refusal the same token can never get past: 400/401/403/404/410, or the server's
 * used or expired invite codes. Anything else (429, 5xx, no answer) may pass later. */
const DEAD_STATUSES = new Set([400, 401, 403, 404, 410]);

/** Whether a failed exchange (`e`; `exchanged`: it got a session first) leaves a dead link. */
export function pairFailureKind(e: unknown, exchanged: boolean): 'refused' | 'temporary' {
  if (exchanged) return 'refused';
  if (!(e instanceof ApiError)) return 'temporary';
  const kind = apiErrorKind(e);
  return DEAD_STATUSES.has(e.status) || kind === 'invite_used' || kind === 'invite_expired'
    ? 'refused'
    : 'temporary';
}

export type LinkPairing = {
  /** A pairing token is being exchanged. */
  pairing: boolean;
  /** Why the last pairing failed, in words. */
  error: string | null;
  /** Say why a link can't pair (a link with no server address). */
  fail: (message: string) => void;
  /** Exchange a pairing link's token on its server and finish the connect flow (on the
   * link's book, when it names one). Resolves how it ended (`PairOutcome`). */
  pair: (scan: PairingScan) => Promise<PairOutcome>;
};

/**
 * Whether the server still takes the stored token of `connectionId` (`GET /me` through the
 * connection's own client, which flags a refused one for reconnect). `needsReconnect` is
 * in memory only, so a fresh tab (the console's "Listen in player" always opens one) can't
 * tell a revoked token from a good one without asking. Only a 401 says no: a server that
 * doesn't answer leaves the book to open as it would offline. Never through the link's
 * base: a link can name any address, and the stored token goes only where it always has.
 */
async function stillSignedIn(connectionId: string): Promise<boolean> {
  const client = resolveClient(connectionId);
  if (!client) return false;
  try {
    await client.me();
    return true;
  } catch (e) {
    return !(e instanceof ApiError && e.status === 401);
  }
}

/**
 * Pairing by link (a pairing QR, an invite link, a pasted link, a deep link): exchange
 * the link's token on the link's server for a session, with the server's own name (read
 * alongside, so the connection isn't named after its host), then `finishConnect` (which
 * merges the link's addresses with the answer's). When the link's https base can't be
 * reached (a self-signed certificate the device can't trust), the exchange goes once to
 * the link's plain-http home address on the same host and port, only when home answers as
 * the server the link names (`pairingFallback`), and the session must come from that
 * server too. The connection is still stored with the https base (which fails safely by
 * TLS on another network, where a plain-http address could be another box), with home as
 * its first address pick (`answeredAt`). A link naming a book ends on it, and skips the
 * exchange when the device is already signed in as the link's user there (its token still
 * taken, `stillSignedIn`). Resolves how it ended (`PairOutcome`). Bare client: a failed
 * exchange must never flag a reconnect.
 */
export function useLinkPairing(startPairing = false): LinkPairing {
  const { t } = useTranslation();
  const [pairing, setPairing] = useState(startPairing);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Stable (`useLatest`): the deep link's effect lists it, and a language switch must not
  // run the exchange again.
  const pair = useLatest(async (scan: PairingScan): Promise<PairOutcome> => {
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
    // The token's exchange at `base`, with the server's name read alongside.
    const exchangeAt = (base: string) => {
      const client = new ApiClient(base);
      return Promise.all([
        client.exchange(scan.token, getDeviceName()),
        client.serverInfo().catch(() => null),
      ]);
    };
    // The exchange is done: a failure after it is this device's (storing the connection),
    // never a server that couldn't be reached.
    let exchanged = false;
    try {
      // The link's https base could not connect (a server on its own certificate): its
      // plain-http home address on the same host and port, once, when home answers as the
      // link's server (`pairingFallback`). Native only: the web player keeps its own
      // origin, and an https page can't call http. A session from any other server there
      // is not kept (reported as the base not answering).
      const {
        answer: [session, info],
        base: answeredAt,
      } = await withFallback(
        scan.base,
        async (base) => {
          const answer = await exchangeAt(base);
          if (base !== scan.base && answer[0].server_id !== scan.serverId) {
            throw new Error('another server answered at the home address');
          }
          return answer;
        },
        async (e) => {
          if (!live.current || Platform.OS === 'web') return null;
          const home = await pairingFallback(scan, e, probeServerId);
          // Left while home was asked: the token goes nowhere more.
          return live.current ? home : null;
        },
      );
      exchanged = true;
      if (!live.current) return 'temporary';
      await finishConnect({
        serverUrl: scan.base,
        session,
        linkAddresses: scan.addresses,
        name: info?.name,
        ...(answeredAt !== scan.base ? { answeredAt } : {}),
        book: scan.book,
      });
      return 'paired';
    } catch (e) {
      if (!live.current) return 'temporary';
      // In words of our own, never the server's English: its limiter (429), a link it
      // refused (expired, used up, unknown: 401; or malformed), it failing itself (5xx), or
      // no answer at all (naming a self-signed certificate only where one may be why,
      // `selfSignedMayBeWhy`, and never for a failure after the exchange).
      setError(
        apiErrorKind(e) === 'too_many'
          ? t('common.tooManyTries')
          : !(e instanceof ApiError)
            ? !exchanged && selfSignedMayBeWhy(scan.base, e, Platform.OS === 'web')
              ? t('connect.server.pairingReachSelfSigned')
              : t('connect.server.pairingReachError')
            : e.status >= 500
              ? t('connect.server.pairingServerError')
              : t('connect.server.pairingRefused'),
      );
      setPairing(false);
      return pairFailureKind(e, exchanged);
    }
  });

  const fail = useLatest((message: string) => {
    setError(message);
    setPairing(false);
  });

  return { pairing, error, fail, pair };
}
