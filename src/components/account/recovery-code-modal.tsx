import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ModalCard } from '@/components/ui/modal-card';
import { Text } from '@/components/ui/text';
import { shareText } from '@/lib/share';

/**
 * Shows a freshly minted recovery code in an always-on-top dialog so the one-time
 * secret can't scroll off-screen or be missed below the fold. The server never
 * returns it again, so dismissing the dialog is the only way to clear it - by
 * which point the user has had the chance to copy or share it.
 */
export function RecoveryCodeModal({ code, onClose }: { code: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <ModalCard visible={code !== null} onRequestClose={onClose}>
      <Text variant="title">{t('account.recoveryModal.title')}</Text>
      <Text variant="muted" className="text-xs">
        {t('account.recoveryModal.description')}
      </Text>
      <Text selectable className="text-center font-roboto-semibold text-lg tracking-wider">
        {code}
      </Text>
      <View className="flex-row gap-2">
        <Button
          title={t('account.recoveryModal.share')}
          variant="secondary"
          icon="qrcode"
          className="flex-1"
          onPress={() => {
            if (code) void shareText(code);
          }}
        />
        <Button title={t('common.done')} variant="ghost" className="flex-1" onPress={onClose} />
      </View>
    </ModalCard>
  );
}
