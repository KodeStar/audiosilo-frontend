import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { ApiKeyCreated } from '@/api/types';
import { Button } from '@/components/ui/button';
import { ModalCard } from '@/components/ui/modal-card';
import { Text } from '@/components/ui/text';
import { copyText } from '@/lib/clipboard';

/**
 * Shows a freshly minted API key's plaintext secret in an always-on-top dialog. The
 * server returns it exactly once, so this is the user's only chance to grab it - the
 * copy button and a selectable secret both cover that, with a plain "won't be shown
 * again" warning. Mirrors {@link RecoveryCodeModal}.
 */
export function ApiKeyCreatedModal({
  created,
  onClose,
}: {
  created: ApiKeyCreated | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  // The modal can't be handed a new secret while open (the create UI sits behind it),
  // so resetting on close is enough to keep the next reveal's button un-confirmed - no
  // effect needed.
  const close = () => {
    setCopied(false);
    onClose();
  };

  const onCopy = async () => {
    if (!created) return;
    // copyText reports whether it reached the clipboard (web) vs. opened the share
    // sheet (native) - only show "Copied" for the former, which we can confirm.
    if (await copyText(created.token)) setCopied(true);
  };

  return (
    <ModalCard visible={created !== null} onRequestClose={close}>
      <Text variant="title">{t('settings.apiKeys.createdModal.title')}</Text>
      <Text variant="muted" className="text-xs">
        {t('settings.apiKeys.createdModal.description')}
      </Text>
      <Text
        selectable
        className="text-center font-roboto-semibold text-base tracking-wider text-gray-700 dark:text-gray-100"
      >
        {created?.token}
      </Text>
      <View className="flex-row gap-2">
        <Button
          title={copied ? t('common.copied') : t('settings.apiKeys.createdModal.copy')}
          variant="secondary"
          icon={copied ? 'check' : undefined}
          className="flex-1"
          onPress={onCopy}
        />
        <Button title={t('common.done')} variant="ghost" className="flex-1" onPress={close} />
      </View>
    </ModalCard>
  );
}
