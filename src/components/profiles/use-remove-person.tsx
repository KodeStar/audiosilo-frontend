import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { invalidateHousehold } from '@/api/hooks';
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
import { serverIdOf } from '@/lib/connection-id';
import { clearPin } from '@/lib/profile-pin';
import { connectionsOfProfile, deleteProfile, type Profile } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';

/**
 * "Remove from this device" for a person (Settings > Household): signs this device out of
 * each of their servers through the same sign-out as an account page (`signOutConnection`:
 * their book stops with its place saved, queued saves land, the token is revoked, their
 * downloads here go), then drops their PIN and profile. Before it, the same warning as
 * signing out (`needsPasswordWarning`, on the freshest flags `/me` gives): a server where
 * they have no password needs a new invite to get back in. A household member (Phase
 * 8b-1, `user.managed_by`) needs none: the line says who manages their account and can
 * sign them in here again or set up their own device. Once they are signed out, the
 * other connections on each of their servers read their household again (the members'
 * devices, the list's device counts, `member_sign_ins`): the owner's page must not keep
 * showing this device under the member. The way out of a forgotten PIN.
 */
export function useRemovePerson(): {
  request: (profile: Profile, name: string) => Promise<void>;
  dialog: ReactNode;
} {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { clients } = useApiRegistry();
  const setConnectionUser = useSession((s) => s.setConnectionUser);
  const [pending, setPending] = useState<{
    profile: Profile;
    name: string;
    servers: Connection[];
    warned: Connection[];
    managed: { connection: Connection; owner: string }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async (profile: Profile, name: string) => {
    const servers = connectionsOfProfile(useSession.getState().connections, profile.connectionIds);
    const warned: Connection[] = [];
    const managed: { connection: Connection; owner: string }[] = [];
    for (const c of servers) {
      const user = await freshAccountUser(c.user, clients.get(c.id), (fresh) => {
        void setConnectionUser(c.id, fresh);
      });
      const owner = user?.managed_by?.username;
      if (owner) managed.push({ connection: c, owner });
      else if (needsPasswordWarning(user)) warned.push(c);
    }
    setPending({ profile, name, servers, warned, managed });
  };

  const remove = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      for (const c of pending.servers) {
        await signOutConnection(c.id, clients.get(c.id) ?? null);
        refreshHousehold(qc, c);
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
            {pending?.managed.map(({ connection: c, owner }) => (
              <Text key={c.id} variant="muted" testID={`remove-person-member-${c.id}`}>
                {t('profiles.remove.member', { name: pending.name, server: c.name, owner })}
              </Text>
            ))}
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

/** `removed` was signed out of this device: every other connection here on its server
 * (its owner's, when it is a household member) reads what showed it signed in here
 * again: the members' devices, the members list and its own devices. */
function refreshHousehold(qc: QueryClient, removed: Connection) {
  const server = serverIdOf(removed);
  for (const c of useSession.getState().connections) {
    if (c.id === removed.id || serverIdOf(c) !== server) continue;
    invalidateHousehold(qc, c.id);
  }
}
