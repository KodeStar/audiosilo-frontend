import { useTranslation } from 'react-i18next';

import type { ApiKeyCreated } from '@/api/types';
import { Button } from '@/components/ui/button';
import { CodeBox, CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

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
  return (
    <Dialog open={created !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.apiKeys.createdModal.title')}</DialogTitle>
          <DialogDescription>{t('settings.apiKeys.createdModal.description')}</DialogDescription>
        </DialogHeader>
        <CodeBox className="py-3" textClassName="text-center text-base">
          {created?.token}
        </CodeBox>
        <DialogFooter>
          <Button title={t('common.done')} variant="ghost" onPress={onClose} />
          <CopyButton text={created?.token ?? ''} title={t('settings.apiKeys.createdModal.copy')} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
