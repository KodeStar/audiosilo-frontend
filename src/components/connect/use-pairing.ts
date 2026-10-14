import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiClient, ApiError, apiErrorKind } from '@/api/client';
import { getDeviceName } from '@/lib/device';
import type { PairingScan } from '@/lib/pairing';
import { useLatest } from '@/lib/use-latest';

import { pairingFallback } from './connect-model';
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
 * the link's plain-http home address on the same host and port (`pairingFallback`), and
 * the connection is stored with that address. Resolves whether it paired. Bare client: a
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
      let serverUrl = scan.base;
      let answer: Awaited<ReturnType<typeof exchangeAt>>;
      try {
        answer = await exchangeAt(scan.base);
      } catch (e) {
        // The link's https base could not connect (a server on its own certificate): its
        // plain-http home address on the same host and port, once (`pairingFallback`). A
        // failure there that isn't the server's own answer reports the base's.
        const home = live.current ? pairingFallback(scan, e) : null;
        if (!home) throw e;
        answer = await exchangeAt(home).catch((e2: unknown) => {
          throw e2 instanceof ApiError ? e2 : e;
        });
        serverUrl = home;
      }
      if (!live.current) return false;
      const [session, info] = answer;
      await finishConnect({
        serverUrl,
        session,
        linkAddresses: scan.addresses,
        name: info?.name,
      });
      return true;
    } catch (e) {
      if (!live.current) return false;
      // In words of our own, never the server's English: its limiter (429), a link it
      // refused (expired, used up, unknown: 401; or malformed), it failing itself (5xx), or
      // no answer at all.
      setError(
        apiErrorKind(e) === 'too_many'
          ? t('common.tooManyTries')
          : !(e instanceof ApiError)
            ? t('connect.server.pairingReachError')
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
