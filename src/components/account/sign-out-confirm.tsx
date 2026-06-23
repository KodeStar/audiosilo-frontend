import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ModalCard } from '@/components/ui/modal-card';
import { Text } from '@/components/ui/text';

/**
 * Confirmation shown before signing out a user who has no durable way back in (no
 * password and no recovery code). It offers to set a recovery credential instead
 * of stranding them. Presentational only — the caller decides what each action
 * does (both the Settings screen and the sidebar mint and reveal a recovery code).
 */
export function SignOutConfirm({
  visible,
  onSetRecovery,
  onSignOut,
  onCancel,
}: {
  visible: boolean;
  onSetRecovery: () => void;
  onSignOut: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ModalCard visible={visible} onRequestClose={onCancel}>
      <Text variant="title">{t('account.signOut.title')}</Text>
      <Text variant="muted">{t('account.signOut.warning')}</Text>
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
