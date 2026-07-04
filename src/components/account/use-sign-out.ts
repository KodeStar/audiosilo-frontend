import { useCallback, useState } from 'react';

import { useOptionalApi } from '@/api/provider';
import { teardownBeforeTokenRevoke } from '@/playback/store';
import { accountFlagsKnown, needsRecoveryWarning } from '@/lib/recovery';
import { useSession } from '@/stores/session';

/**
 * The single guarded sign-out chokepoint, scoped to one connection. Every place that
 * signs a user out of a server goes through `requestSignOut` so the "you have no way
 * back in" warning can't be forgotten by a new call site - the footgun is owned here,
 * not re-implemented in each screen.
 *
 * The account it acts on is the passed `connectionId`'s (not the ambient "active" one),
 * so signing out from that connection's account screen targets *that* server.
 *
 * `requestSignOut` decides on the freshest account flags it can get: a session
 * persisted before `has_password`/`has_recovery` existed has them `undefined`, so
 * we fetch `/me` once before deciding rather than guessing. When the server is
 * unreachable we fall back to whatever we have and don't warn - offline there's no
 * way to mint a recovery code anyway, so a warning would be a dead end.
 */
export function useSignOut(connectionId: string) {
  const api = useOptionalApi(connectionId);
  const user = useSession((s) => s.connections.find((c) => c.id === connectionId)?.user ?? null);
  const setConnectionUser = useSession((s) => s.setConnectionUser);
  const removeConnection = useSession((s) => s.removeConnection);
  const [confirmVisible, setConfirmVisible] = useState(false);

  const signOut = useCallback(async () => {
    setConfirmVisible(false);
    // Shared token-revoking teardown: stop playback through this connection (persisting
    // the final position while the token is still valid - otherwise the book keeps
    // playing with no mini-player in the connect screen to stop it) and replay its
    // queued progress (removing the connection below purges those saves, so this is
    // the last chance to land them). A book playing through another connection keeps
    // going; its token stays valid.
    await teardownBeforeTokenRevoke(connectionId);
    try {
      await api?.logout();
    } catch {
      // ignore; clear locally regardless
    }
    await removeConnection(connectionId);
  }, [api, connectionId, removeConnection]);

  const requestSignOut = useCallback(async () => {
    let current = user;
    if (current && !accountFlagsKnown(current) && api) {
      try {
        current = await api.me();
        void setConnectionUser(connectionId, current);
      } catch {
        // offline / unreachable: decide on what we already have
      }
    }
    if (needsRecoveryWarning(current)) setConfirmVisible(true);
    else void signOut();
  }, [user, api, connectionId, setConnectionUser, signOut]);

  return { confirmVisible, setConfirmVisible, signOut, requestSignOut };
}
