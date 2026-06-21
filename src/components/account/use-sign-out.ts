import { useCallback, useState } from 'react';

import { useOptionalApi } from '@/api/provider';
import { accountFlagsKnown, needsRecoveryWarning } from '@/lib/recovery';
import { useSession } from '@/stores/session';

/**
 * The single guarded sign-out chokepoint. Every place that signs the user out
 * goes through `requestSignOut` so the "you have no way back in" warning can't be
 * forgotten by a new call site — the footgun is owned here, not re-implemented in
 * each screen.
 *
 * `requestSignOut` decides on the freshest account flags it can get: a session
 * persisted before `has_password`/`has_recovery` existed has them `undefined`, so
 * we fetch `/me` once before deciding rather than guessing. When the server is
 * unreachable we fall back to whatever we have and don't warn — offline there's no
 * way to mint a recovery code anyway, so a warning would be a dead end.
 */
export function useSignOut() {
  const api = useOptionalApi();
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const logout = useSession((s) => s.logout);
  const [confirmVisible, setConfirmVisible] = useState(false);

  const signOut = useCallback(async () => {
    setConfirmVisible(false);
    try {
      await api?.logout();
    } catch {
      // ignore; clear locally regardless
    }
    await logout();
  }, [api, logout]);

  const requestSignOut = useCallback(async () => {
    let current = user;
    if (current && !accountFlagsKnown(current) && api) {
      try {
        current = await api.me();
        void setUser(current);
      } catch {
        // offline / unreachable: decide on what we already have
      }
    }
    if (needsRecoveryWarning(current)) setConfirmVisible(true);
    else void signOut();
  }, [user, api, setUser, signOut]);

  return { confirmVisible, setConfirmVisible, signOut, requestSignOut };
}
