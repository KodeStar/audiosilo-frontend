import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { useOptionalApi } from '@/api/provider';
import { toast } from '@/components/ui/toast';
import { useSession } from '@/stores/session';

/** The shortest password the server takes. */
export const PW_MIN = 8;

/**
 * Setting or changing one connection's password: the conventional way back in after a
 * sign-out. A new password must be a real one (at least 8, matching the server);
 * changing an existing password requires the current one, so a stolen session can't
 * silently replace a known password. The editor is a dialog (`PasswordDialog`), which
 * lifts above the software keyboard on a phone.
 */
export function usePasswordEditor(connectionId: string) {
  const { t } = useTranslation();
  const api = useOptionalApi(connectionId);
  const user = useSession((s) => s.connections.find((c) => c.id === connectionId)?.user ?? null);
  const setConnectionUser = useSession((s) => s.setConnectionUser);
  const hasPassword = !!user?.has_password;

  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPassword('');
    setCurrent('');
    setError(null);
  }, []);

  const canSave = password.length >= PW_MIN && (!hasPassword || current.length > 0) && !busy;

  const save = async () => {
    if (!api || busy) return;
    if (password.length < PW_MIN) {
      setError(t('settings.account.password.minError', { count: PW_MIN }));
      return;
    }
    if (hasPassword && current.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      // Changing an existing password requires the current one; setting a first
      // password (a password-less account) does not.
      await api.setPassword(password, hasPassword ? current : undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('settings.account.password.updateError'));
      setBusy(false);
      return;
    }
    setBusy(false);
    close();
    toast({
      title: t(hasPassword ? 'account.password.doneChanged' : 'account.password.doneSet'),
      description: t('account.password.doneBody'),
    });
    // The change has landed; refreshing has_password is best-effort and must not
    // surface as a "could not update the password" error if /me hiccups.
    try {
      await setConnectionUser(connectionId, await api.me());
    } catch {
      // ignore - the password change succeeded regardless
    }
  };

  return {
    hasPassword,
    open,
    openEditor: useCallback(() => setOpen(true), []),
    close,
    password,
    setPassword,
    current,
    setCurrent,
    busy,
    error,
    canSave,
    save,
  };
}

export type PasswordEditor = ReturnType<typeof usePasswordEditor>;
