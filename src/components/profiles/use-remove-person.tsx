import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useApiRegistry } from '@/api/provider';
import { freshAccountUser, signOutConnection } from '@/components/account/use-sign-out';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { DialogIcon } from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';
import { needsPasswordWarning } from '@/lib/account';
import { clearPin } from '@/lib/profile-pin';
import { connectionsOfProfile, deleteProfile, type Profile } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';

/**
 * "Remove from this device" for a person (Settings > Household): signs this device out of
 * each of their servers through the same sign-out as an account page (`signOutConnection`:
 * their book stops with its place saved, queued saves land, the token is revoked, their
 * downloads here go), then drops their PIN and profile. Before it, the same warning as
 * signing out (`needsPasswordWarning`, on the freshest flags `/me` gives): a server where
 * they have no password needs a new invite to get back in. The way out of a forgotten PIN.
 */
export function useRemovePerson(): {
  request: (profile: Profile, name: string) => Promise<void>;
  dialog: ReactNode;
} {
  const { t } = useTranslation();
  const { clients } = useApiRegistry();
  const setConnectionUser = useSession((s) => s.setConnectionUser);
  const [pending, setPending] = useState<{
    profile: Profile;
    name: string;
    servers: Connection[];
    warned: Connection[];
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async (profile: Profile, name: string) => {
    const servers = connectionsOfProfile(useSession.getState().connections, profile.connectionIds);
    const warned: Connection[] = [];
    for (const c of servers) {
      const user = await freshAccountUser(c.user, clients.get(c.id), (fresh) => {
        void setConnectionUser(c.id, fresh);
      });
      if (needsPasswordWarning(user)) warned.push(c);
    }
    setPending({ profile, name, servers, warned });
  };

  const remove = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      for (const c of pending.servers) {
        await signOutConnection(c.id, clients.get(c.id) ?? null);
      }
      await clearPin(pending.profile.id).catch(() => undefined);
      deleteProfile(pending.profile.id);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const servers = pending?.servers.map((c) => c.name).join(', ') ?? '';
  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(o) => !o && !busy && setPending(null)}>
      <AlertDialogContent>
        <View className="flex-row items-start gap-3.5">
          <DialogIcon name="logout" tone="destructive" />
          <AlertDialogHeader className="flex-1">
            <AlertDialogTitle>
              {t('profiles.remove.title', { name: pending?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('profiles.remove.body', { name: pending?.name ?? '', servers })}
            </AlertDialogDescription>
            {pending?.warned.map((c) => (
              <Text key={c.id} variant="muted" className="text-destructive">
                {t('profiles.remove.noPassword', { name: pending.name, server: c.name })}
              </Text>
            ))}
          </AlertDialogHeader>
        </View>
        <AlertDialogFooter>
          <Button
            title={t('common.cancel')}
            variant="ghost"
            disabled={busy}
            onPress={() => setPending(null)}
          />
          <Button
            testID="remove-person-confirm"
            title={t('profiles.remove.confirm')}
            variant="destructive"
            icon="logout"
            loading={busy}
            onPress={() => void remove()}
          />
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { request, dialog };
}
