import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiKeyCreated } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';
import { copyText } from '@/lib/clipboard';

/**
 * Shows a freshly minted API key's plaintext secret in a dialog. The server returns it
 * exactly once, so this is the user's only chance to grab it - the copy button and a
 * selectable secret both cover that, with a plain "won't be shown again" warning.
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
    <Dialog open={created !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.apiKeys.createdModal.title')}</DialogTitle>
          <DialogDescription>{t('settings.apiKeys.createdModal.description')}</DialogDescription>
        </DialogHeader>
        <Text
          selectable
          variant="mono"
          className="rounded-control bg-muted px-3 py-3 text-center text-base"
        >
          {created?.token}
        </Text>
        <DialogFooter>
          <Button title={t('common.done')} variant="ghost" onPress={close} />
          <Button
            title={copied ? t('common.copied') : t('settings.apiKeys.createdModal.copy')}
            icon={copied ? 'check' : 'copy'}
            onPress={onCopy}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
