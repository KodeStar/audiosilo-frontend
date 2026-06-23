import { useCallback, useState } from 'react';

import { ApiError } from '@/api/client';
import { useOptionalApi } from '@/api/provider';
import i18n from '@/i18n';
import { useSession } from '@/stores/session';

/**
 * Mint (or replace) the signed-in user's durable recovery code. Shared by the
 * Settings screen and the sign-out warning so both reveal the code the same way.
 *
 * Generating *replaces* any existing code server-side, so `requestGenerate`
 * confirms first when the user already has one (the caller renders a confirmation
 * from `confirmRegen`). The minted code is surfaced via `code` for an
 * always-visible dialog; the follow-up `/me` refresh of `has_recovery` is
 * best-effort and never reported as a generation failure.
 */
export function useRecoveryCode() {
  const api = useOptionalApi();
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);

  const generate = useCallback(async () => {
    if (!api) return;
    setError(null);
    setBusy(true);
    try {
      const minted = await api.generateRecoveryCode();
      setCode(minted);
      try {
        void setUser(await api.me()); // refresh has_recovery (best-effort)
      } catch {
        // the code was minted regardless; a stale flag is harmless
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : i18n.t('account.recovery.generateError'));
    } finally {
      setBusy(false);
    }
  }, [api, setUser]);

  const requestGenerate = useCallback(() => {
    if (user?.has_recovery) setConfirmRegen(true);
    else void generate();
  }, [user?.has_recovery, generate]);

  const confirmGenerate = useCallback(() => {
    setConfirmRegen(false);
    void generate();
  }, [generate]);

  return {
    code,
    setCode,
    busy,
    error,
    confirmRegen,
    setConfirmRegen,
    requestGenerate,
    confirmGenerate,
  };
}
