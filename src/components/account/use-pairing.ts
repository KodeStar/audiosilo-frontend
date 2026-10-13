import type { TFunction } from 'i18next';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, apiErrorKind } from '@/api/client';
import { useOptionalApi } from '@/api/provider';
import type { PairingPayload } from '@/api/types';
import { useNow } from '@/lib/use-now';

import { PAIRING_TTL_MS, pairingSecondsLeft } from './account-model';

/** What `usePairingCode` gives a code's view (`PairingCode`). */
export type PairingCodeState = {
  payload: PairingPayload | null;
  secondsLeft: number;
  expired: boolean;
  loading: boolean;
  error: string | null;
  create: () => Promise<void>;
  dismiss: () => void;
};

/**
 * A single-use pairing code from `mint` (null: nothing to ask yet): the server's QR image
 * and `web_url`. The code works once, for 10 minutes; the hook counts down from when it
 * arrived and marks it expired at 0 (the view then offers a new one). A code that could
 * not be made says `errorText(e)`: the caller's own words, never the server's (its
 * English), telling a refusal apart from no answer (`pairingError`).
 */
export function usePairingCode(
  mint: (() => Promise<PairingPayload>) | null,
  errorText: (e: unknown) => string,
): PairingCodeState {
  const [pairing, setPairing] = useState<{ payload: PairingPayload; expiresAt: number } | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A one-second tick only while a live code shows. It reads the clock, not a counter,
  // so a phone that slept through the countdown wakes to the right time.
  const [ticking, setTicking] = useState(false);
  const now = useNow(1000, ticking);
  const secondsLeft = pairing ? pairingSecondsLeft(pairing.expiresAt, now) : 0;
  const expired = pairing !== null && secondsLeft === 0;
  const live = pairing !== null && !expired;
  // Follows the code during render (React's way to keep state in step with other state).
  if (ticking !== live) setTicking(live);

  // A plain function: a caller's `mint` is a new closure every render.
  const create = async () => {
    if (!mint || loading) return;
    setError(null);
    setLoading(true);
    try {
      const payload = await mint();
      setPairing({ payload, expiresAt: Date.now() + PAIRING_TTL_MS });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

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

/** What a pairing code `POST /auth/pair` could not make says (`usePairingCode`),
 * translated: too many tries (429), a kid's account (403 `kid_account`), any other answer
 * the server refused with (it was reached: never "couldn't reach"), else no answer. */
function pairingError(e: unknown, server: string, t: TFunction): string {
  const kind = apiErrorKind(e);
  if (kind === 'too_many') return t('common.tooManyTries');
  if (kind === 'kid_account') return t('account.pair.kid');
  return e instanceof ApiError
    ? t('account.pair.refused', { server })
    : t('account.pair.error', { server });
}

/**
 * Self-service device pairing for one connection: mint a fresh pairing code
 * (`POST /auth/pair`) so another device can scan it or open the link and pair without an
 * admin (`usePairingCode`).
 */
export function usePairing(connectionId: string, serverName: string): PairingCodeState {
  const { t } = useTranslation();
  const api = useOptionalApi(connectionId);
  return usePairingCode(api ? () => api.pair() : null, (e) => pairingError(e, serverName, t));
}
