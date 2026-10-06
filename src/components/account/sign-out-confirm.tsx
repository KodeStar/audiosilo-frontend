import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

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

/**
 * Confirmation shown before signing out a user who has no durable way back in (no
 * password). It offers to set a password instead of stranding them. Presentational
 * only - the caller decides what each action does (the per-connection account screen
 * opens its set-password editor). Signing out removes the named connection, which
 * purges its downloads, so it also warns when that server has downloaded books
 * (counted against `connectionId`).
 */
export function SignOutConfirm({
  visible,
  connectionId,
  onSetPassword,
  onSignOut,
  onCancel,
}: {
  visible: boolean;
  connectionId: string;
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
            <AlertDialogDescription>{t('account.signOut.warning')}</AlertDialogDescription>
            {downloadCount > 0 ? (
              <Text variant="muted">
                {t('account.signOut.downloadsWarning', { count: downloadCount })}
              </Text>
            ) : null}
          </AlertDialogHeader>
        </View>
        {/* Stacked, the way out first: setting a password is the recommended answer. */}
        <View className="gap-2">
          <Button title={t('account.signOut.setPassword')} size="lg" onPress={onSetPassword} />
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
