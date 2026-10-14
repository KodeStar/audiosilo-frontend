import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import { ApiClient, ApiError, apiErrorKind, TimeoutError } from '@/api/client';
import { probeServerId } from '@/api/server-id-probe';
import { getDeviceName } from '@/lib/device';
import type { PairingScan } from '@/lib/pairing';
import { useLatest } from '@/lib/use-latest';

import { pairingFallback, withFallback } from './connect-model';
import { finishConnect } from './finish-connect';

export type LinkPairing = {
  /** A pairing token is being exchanged. */
  pairing: boolean;
  /** Why the last pairing failed, in words. */
  error: string | null;
  /** Say why a link can't pair (a link with no server address). */
  fail: (message: string) => void;
  /** Exchange a pairing link's token on its server and finish the connect flow. */
  pair: (scan: PairingScan) => Promise<boolean>;
};

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
 * its first address pick (`answeredAt`). Resolves whether it paired. Bare client: a
 * failed exchange must never flag a reconnect.
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
  const pair = useLatest(async (scan: PairingScan): Promise<boolean> => {
    setError(null);
    setPairing(true);
    // The token's exchange at `base`, with the server's name read alongside.
    const exchangeAt = (base: string) => {
      const client = new ApiClient(base);
      return Promise.all([
        client.exchange(scan.token, getDeviceName()),
        client.serverInfo().catch(() => null),
      ]);
    };
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
      if (!live.current) return false;
      await finishConnect({
        serverUrl: scan.base,
        session,
        linkAddresses: scan.addresses,
        name: info?.name,
        ...(answeredAt !== scan.base ? { answeredAt } : {}),
      });
      return true;
    } catch (e) {
      if (!live.current) return false;
      // In words of our own, never the server's English: its limiter (429), a link it
      // refused (expired, used up, unknown: 401; or malformed), it failing itself (5xx), or
      // no answer at all (naming a self-signed certificate only where one may be why: an
      // https link on native that failed without timing out).
      setError(
        apiErrorKind(e) === 'too_many'
          ? t('common.tooManyTries')
          : !(e instanceof ApiError)
            ? Platform.OS !== 'web' &&
              /^https:\/\//i.test(scan.base) &&
              !(e instanceof TimeoutError)
              ? t('connect.server.pairingReachSelfSigned')
              : t('connect.server.pairingReachError')
            : e.status >= 500
              ? t('connect.server.pairingServerError')
              : t('connect.server.pairingRefused'),
      );
      setPairing(false);
      return false;
    }
  });

  const fail = useLatest((message: string) => {
    setError(message);
    setPairing(false);
  });

  return { pairing, error, fail, pair };
}
