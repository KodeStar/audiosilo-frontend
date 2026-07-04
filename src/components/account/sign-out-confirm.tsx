import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ModalCard } from '@/components/ui/modal-card';
import { Text } from '@/components/ui/text';
import { downloadedCountFor, useDownloads } from '@/downloads/store';

/**
 * Confirmation shown before signing out a user who has no durable way back in (no
 * password and no recovery code). It offers to set a recovery credential instead
 * of stranding them. Presentational only - the caller decides what each action
 * does (the per-connection account screen mints and reveals a recovery code).
 * Signing out removes the named connection, which purges its downloads, so it also
 * warns when that server has downloaded books (counted against `connectionId`).
 */
export function SignOutConfirm({
  visible,
  connectionId,
  onSetRecovery,
  onSignOut,
  onCancel,
}: {
  visible: boolean;
  connectionId: string;
  onSetRecovery: () => void;
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
    <ModalCard visible={visible} onRequestClose={onCancel}>
      <Text variant="title">{t('account.signOut.title')}</Text>
      <Text variant="muted">{t('account.signOut.warning')}</Text>
      {downloadCount > 0 ? (
        <Text variant="muted">
          {t('account.signOut.downloadsWarning', { count: downloadCount })}
        </Text>
      ) : null}
      <View className="gap-2">
        <Button title={t('account.signOut.setRecovery')} icon="qrcode" onPress={onSetRecovery} />
        <Button
          title={t('account.signOut.confirm')}
          variant="secondary"
          icon="logout"
          onPress={onSignOut}
        />
        <Button title={t('common.cancel')} variant="ghost" onPress={onCancel} />
      </View>
    </ModalCard>
  );
}
