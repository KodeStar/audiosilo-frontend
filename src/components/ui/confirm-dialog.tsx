import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

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
import type { IconName } from '@/components/ui/icon';

/**
 * A generic two-action confirmation on `AlertDialog`. The caller owns visibility and
 * what each action does; Escape (web) and Android back count as cancel. Portaled, so it
 * can be rendered from anywhere in the tree.
 */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  confirmIcon,
  destructive = false,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmIcon?: IconName;
  /** The action loses something (a server, its downloads): a red confirm button. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={visible} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <View className="flex-row items-start gap-3.5">
          {confirmIcon ? (
            <DialogIcon name={confirmIcon} tone={destructive ? 'destructive' : 'default'} />
          ) : null}
          <AlertDialogHeader className="flex-1">
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{message}</AlertDialogDescription>
          </AlertDialogHeader>
        </View>
        <AlertDialogFooter>
          <Button title={t('common.cancel')} variant="ghost" onPress={onCancel} />
          <Button
            title={confirmLabel}
            variant={destructive ? 'destructive' : 'default'}
            onPress={onConfirm}
          />
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
