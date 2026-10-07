import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { useOptionalApi } from '@/api/provider';
import type { PairingPayload } from '@/api/types';

import { PAIRING_TTL_MS, pairingSecondsLeft } from './account-model';

/**
 * Self-service device pairing for one connection: mint a fresh pairing code
 * (`POST /auth/pair`: the server's QR image and `web_url`) so another device can scan it
 * or open the link and pair without an admin. The code works once, for 10 minutes; the
 * hook counts down from when it arrived and marks it expired at 0 (the card then offers
 * a new one).
 */
export function usePairing(connectionId: string, serverName: string) {
  const { t } = useTranslation();
  const api = useOptionalApi(connectionId);
  const [pairing, setPairing] = useState<{ payload: PairingPayload; expiresAt: number } | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const secondsLeft = pairing ? pairingSecondsLeft(pairing.expiresAt, now) : 0;
  const expired = pairing !== null && secondsLeft === 0;

  // A one-second tick while a live code shows. It reads the clock, not a counter, so a
  // phone that slept through the countdown wakes to the right time.
  useEffect(() => {
    if (!pairing || expired) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pairing, expired]);

  const create = useCallback(async () => {
    if (!api || loading) return;
    setError(null);
    setLoading(true);
    try {
      const payload = await api.pair();
      const at = Date.now();
      setNow(at);
      setPairing({ payload, expiresAt: at + PAIRING_TTL_MS });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('account.pair.error', { server: serverName }));
    } finally {
      setLoading(false);
    }
  }, [api, loading, serverName, t]);

  return {
    payload: pairing?.payload ?? null,
    secondsLeft,
    expired,
    loading,
    error,
    create,
    dismiss: useCallback(() => setPairing(null), []),
  };
}
