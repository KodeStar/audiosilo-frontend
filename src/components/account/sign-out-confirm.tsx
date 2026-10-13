import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { User } from '@/api/types';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { DialogIcon } from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';
import { downloadedCountFor, useDownloads } from '@/downloads/store';
import { isKidAccount, managerName } from '@/lib/account';

/** What signing out without a password means for `user`: an ordinary account needs a new
 * invite from its admin; a household member's owner can sign it in again from their
 * Household page (8b-1), and a kid's account can't have a password at all. */
export function signOutWarning(
  user: Pick<User, 'managed_by' | 'member_kind'> | null | undefined,
  t: TFunction,
): string {
  const owner = managerName(user);
  if (!owner) return t('account.signOut.warning');
  return t(isKidAccount(user) ? 'account.signOut.warningKid' : 'account.signOut.warningMember', {
    owner,
  });
}

/**
 * Confirmation shown before signing out a user who has no durable way back in (no
 * password). It offers to set a password instead of stranding them (not to a kid's
 * account, which can't have one; `signOutWarning` says who signs it in). Presentational
 * only - the caller decides what each action does (the per-connection account screen
 * opens its set-password editor). Signing out removes the named connection, which
 * purges its downloads, so it also warns when that server has downloaded books
 * (counted against `connectionId`).
 */
export function SignOutConfirm({
  visible,
  connectionId,
  user,
  onSetPassword,
  onSignOut,
  onCancel,
}: {
  visible: boolean;
  connectionId: string;
  /** The account being signed out (`managed_by`, `member_kind`: what the warning says). */
  user?: Pick<User, 'managed_by' | 'member_kind'> | null;
  onSetPassword: () => void;
  onSignOut: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  // The dialog stays mounted (hidden) in the account screen, so only count while
  // visible - otherwise this selector would filter the registry on every download
  // progress tick.
  const downloadCount = useDownloads((s) =>
    visible ? downloadedCountFor(s.entries, connectionId) : 0,
  );
  return (
    <AlertDialog open={visible} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <View className="flex-row items-start gap-3.5">
          <DialogIcon name="logout" tone="destructive" />
          <AlertDialogHeader className="flex-1">
            <AlertDialogTitle>{t('account.signOut.title')}</AlertDialogTitle>
            <AlertDialogDescription>{signOutWarning(user, t)}</AlertDialogDescription>
            {downloadCount > 0 ? (
              <Text variant="muted">
                {t('account.signOut.downloadsWarning', { count: downloadCount })}
              </Text>
            ) : null}
          </AlertDialogHeader>
        </View>
        {/* Stacked, the way out first: setting a password is the recommended answer. */}
        <View className="gap-2">
          {isKidAccount(user) ? null : (
            <Button title={t('account.signOut.setPassword')} size="lg" onPress={onSetPassword} />
          )}
          <Button
            title={t('account.signOut.confirm')}
            variant="destructive-outline"
            size="lg"
            icon="logout"
            onPress={onSignOut}
          />
          <Button title={t('common.cancel')} variant="ghost" size="lg" onPress={onCancel} />
        </View>
      </AlertDialogContent>
    </AlertDialog>
  );
}
