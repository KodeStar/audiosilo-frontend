import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { IconName } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { ModalCard } from '@/components/ui/modal-card';
import { Text } from '@/components/ui/text';

/**
 * A generic two-action confirmation dialog. The caller owns visibility and what
 * each action does; this only renders the title/message and the confirm/cancel
 * buttons over the shared {@link ModalCard}.
 */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  confirmIcon,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmIcon?: IconName;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ModalCard visible={visible} onRequestClose={onCancel}>
      <Text variant="title">{title}</Text>
      <Text variant="muted">{message}</Text>
      <View className="gap-2">
        <Button title={confirmLabel} icon={confirmIcon} onPress={onConfirm} />
        <Button title={t('common.cancel')} variant="ghost" onPress={onCancel} />
      </View>
    </ModalCard>
  );
}
