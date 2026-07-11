import { useCallback, useState } from 'react';

import { ApiError } from '@/api/client';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '@/api/hooks';
import type { ApiKey, ApiKeyCreated } from '@/api/types';
import i18n from '@/i18n';

/**
 * Owns the API-keys section's UI state (name input, the one-time secret reveal, and
 * the revoke confirmation) on top of the connection-scoped React Query hooks, so the
 * account screen can render the reveal modal and revoke confirmation at screen level
 * (a `ModalCard` must not live inside the settings `ScrollView`) while the in-scroll
 * section just reads/drives this state.
 *
 * `enabled` gates the list query on the server's `api_keys` capability and the
 * non-demo rule, so an older server (or a demo account) is never queried.
 */
export function useApiKeysManager(connectionId: string, enabled: boolean) {
  const list = useApiKeys(enabled, connectionId);
  const createMut = useCreateApiKey(connectionId);
  const revokeMut = useRevokeApiKey(connectionId);

  const [label, setLabelState] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ApiKey | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Editing the name clears a stale "could not create" error so it can't linger under a
  // field the user has since corrected (it only re-shows on the next failed create).
  const setLabel = useCallback((value: string) => {
    setLabelState(value);
    setCreateError(null);
  }, []);

  const create = useCallback(async () => {
    const name = label.trim();
    // Guard an empty label (server 400s) AND an in-flight create: the Create button is
    // disabled while pending, but the keyboard-submit path (onSubmitEditing) is not, so
    // without the isPending check a second Return before the round-trip resolves would
    // mint a duplicate key.
    if (!name || createMut.isPending) return;
    setCreateError(null);
    try {
      const res = await createMut.mutateAsync(name);
      setCreated(res); // reveal the one-time secret; the list refresh happens onSuccess
      setLabelState('');
    } catch (e) {
      setCreateError(e instanceof ApiError ? e.message : i18n.t('settings.apiKeys.createError'));
    }
  }, [label, createMut]);

  const requestRevoke = useCallback((key: ApiKey) => {
    setRevokeError(null);
    setPendingRevoke(key);
  }, []);
  const cancelRevoke = useCallback(() => setPendingRevoke(null), []);
  const confirmRevoke = useCallback(() => {
    const key = pendingRevoke;
    setPendingRevoke(null);
    if (!key) return;
    setRevokeError(null);
    // Fire-and-forget, but surface a failure: a silently-failed revoke of a leaked key
    // would leave the user believing a still-live credential is dead.
    revokeMut.mutate(key.id, {
      onError: (e) =>
        setRevokeError(e instanceof ApiError ? e.message : i18n.t('settings.apiKeys.revokeError')),
    });
  }, [pendingRevoke, revokeMut]);

  return {
    keys: list.data ?? [],
    isLoading: list.isLoading,
    isError: list.isError,
    label,
    setLabel,
    canCreate: label.trim().length > 0 && !createMut.isPending,
    createBusy: createMut.isPending,
    createError,
    create,
    created,
    dismissCreated: useCallback(() => setCreated(null), []),
    pendingRevoke,
    requestRevoke,
    confirmRevoke,
    cancelRevoke,
    revokeError,
  };
}

export type ApiKeysManager = ReturnType<typeof useApiKeysManager>;
