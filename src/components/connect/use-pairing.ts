import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiClient, ApiError } from '@/api/client';
import { getDeviceName } from '@/lib/device';
import type { PairingScan } from '@/lib/pairing';
import { useLatest } from '@/lib/use-latest';

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
 * merges the link's addresses with the answer's). Resolves whether it paired. Bare
 * client: a failed exchange must never flag a reconnect.
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
    try {
      const client = new ApiClient(scan.base);
      const [session, info] = await Promise.all([
        client.exchange(scan.token, getDeviceName()),
        client.serverInfo().catch(() => null),
      ]);
      if (!live.current) return false;
      await finishConnect({
        serverUrl: scan.base,
        session,
        linkAddresses: scan.addresses,
        name: info?.name,
      });
      return true;
    } catch (e) {
      if (!live.current) return false;
      setError(
        e instanceof ApiError
          ? t('connect.server.pairingFailed', { message: e.message })
          : t('connect.server.pairingReachError'),
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
