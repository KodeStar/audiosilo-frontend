import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { useMyDevices, useReadMyDevicesAgain, useServerInfo } from '@/api/hooks';
import type { MyDevice } from '@/api/types';
import { useOptionalApi } from '@/api/provider';
import { toast } from '@/components/ui/toast';
import { versionAtLeast } from '@/lib/server-version';
import { useSession } from '@/stores/session';
import { forgetPair } from '@/watch/watch-store';

/** The shortest password the server takes. */
export const PW_MIN = 8;

/** How many of the account's other devices are signed in (sessions, never API keys), or
 * undefined when the list is not known. */
const othersSignedIn = (devices: readonly MyDevice[] | undefined) =>
  devices?.filter((d) => d.kind === 'session' && !d.current).length;

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
  const readDevicesAgain = useReadMyDevicesAgain(connectionId);
  // The devices as the list holds them (the Account page shows it), read as a change is
  // saved: what it can have ended.
  const devicesNow = useMyDevices(connectionId).data;
  // A change ends the open pairing codes on a server since server#281 (2.6.0): an older one
  // keeps them, and a code on screen with them. An unknown version is taken as a new one.
  const endsPairing = versionAtLeast(useServerInfo(connectionId).data?.version, '2.6.0') !== false;
  const user = useSession((s) => s.connections.find((c) => c.id === connectionId)?.user ?? null);
  const setConnectionUser = useSession((s) => s.setConnectionUser);
  const hasPassword = !!user?.has_password;

  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Counts the changes of an existing password that ended the open pairing codes (a server
  // that ends the person's other sessions on one, `endsPairing`), so a code on screen is
  // put away.
  const [changes, setChanges] = useState(0);

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
    const othersBefore = othersSignedIn(devicesNow);
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
    // The change has landed; refreshing has_password (and has_recovery, which a change
    // clears) is best-effort and must not surface as a "could not update the password"
    // error if /me hiccups. Asked now, beside the devices read below.
    const refreshUser = api
      .me()
      .then((u) => setConnectionUser(connectionId, u))
      .catch(() => {
        // ignore - the password change succeeded regardless
      });
    // What the toast says of the other devices is what the server did: setting a first
    // password ends nothing; a change ends the other sessions on a server since
    // server#281 and none before, with nothing on the wire telling them apart, so the
    // devices read again (which also clears the ended ones from the list) answer, against
    // the list as it was: "signed out" only when there were others and none is left
    // (server#285). No answer, or none before: only this device is sure.
    let body:
      | 'account.password.doneBody'
      | 'account.password.doneThisDevice'
      | 'account.password.doneSignedOut' = 'account.password.doneBody';
    if (hasPassword) {
      if (endsPairing) {
        setChanges((n) => n + 1);
        // The change ended the account's open pairing tokens, the one on its way to a watch too.
        forgetPair(connectionId);
      }
      const others = othersSignedIn(await readDevicesAgain());
      if (others === undefined) body = 'account.password.doneThisDevice';
      else if (others === 0)
        body = othersBefore ? 'account.password.doneSignedOut' : 'account.password.doneThisDevice';
    }
    toast({
      title: t(hasPassword ? 'account.password.doneChanged' : 'account.password.doneSet'),
      description: t(body),
    });
    await refreshUser;
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
    changes,
  };
}

export type PasswordEditor = ReturnType<typeof usePasswordEditor>;
