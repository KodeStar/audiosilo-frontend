import { useCallback, useState } from 'react';

import type { ApiClient } from '@/api/client';
import type { User } from '@/api/types';
import { useOptionalApi } from '@/api/provider';
import { teardownBeforeTokenRevoke } from '@/playback/store';
import { accountFlagsKnown, needsPasswordWarning } from '@/lib/account';
import { useSession } from '@/stores/session';

/**
 * Sign this device out of one connection: stop playback through it and replay its queued
 * saves while its token still works (`teardownBeforeTokenRevoke`), revoke the token on the
 * server (best effort), then forget the connection here. The body of `useSignOut`'s
 * `signOut`, shared with removing a person from this device (Settings > Household), which
 * signs out each of their servers after the same password warning.
 */
export async function signOutConnection(
  connectionId: string,
  api: ApiClient | null,
  removeConnection: (id: string) => Promise<void> = (id) =>
    useSession.getState().removeConnection(id),
) {
  await teardownBeforeTokenRevoke(connectionId);
  try {
    await api?.logout();
  } catch {
    // ignore; clear locally regardless
  }
  await removeConnection(connectionId);
}

/**
 * The account to decide the no-password warning on (`needsPasswordWarning`), with the
 * freshest flags it can get: `user` as it is when its flags are known; else `/me` (a
 * session persisted before `has_password` existed), handed to `save` for the
 * connection; else, offline or unreachable, `user` as it is (offline there's no way to set
 * a password anyway, so a warning would be a dead end). Shared by signing out and
 * removing a person from this device.
 */
export async function freshAccountUser(
  user: User | null,
  api: ApiClient | null | undefined,
  save: (fresh: User) => void,
): Promise<User | null> {
  if (!user || accountFlagsKnown(user) || !api) return user;
  try {
    const fresh = await api.me();
    save(fresh);
    return fresh;
  } catch {
    return user;
  }
}

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
 * persisted before `has_password` existed has it `undefined`, so we fetch `/me`
 * once before deciding rather than guessing. When the server is unreachable we fall
 * back to whatever we have and don't warn - offline there's no way to set a password
 * anyway, so a warning would be a dead end.
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
    await signOutConnection(connectionId, api, removeConnection);
  }, [api, connectionId, removeConnection]);

  const requestSignOut = useCallback(async () => {
    const current = await freshAccountUser(user, api, (fresh) => {
      void setConnectionUser(connectionId, fresh);
    });
    if (needsPasswordWarning(current)) setConfirmVisible(true);
    else void signOut();
  }, [user, api, connectionId, setConnectionUser, signOut]);

  return { confirmVisible, setConfirmVisible, signOut, requestSignOut };
}
