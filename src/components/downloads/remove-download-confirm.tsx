import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { formatBytes } from '@/lib/format';

/**
 * "Remove this download?": the one confirm for deleting a downloaded book, from the
 * Downloads page and the book page alike. Getting it back means downloading it again,
 * so it asks first and says how much room it frees. Open while `book` is set.
 */
export function RemoveDownloadConfirm({
  book,
  onCancel,
  onConfirm,
}: {
  book: { title: string; bytes: number } | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const message = book
    ? [
        t('downloads.remove.message', { title: book.title }),
        book.bytes > 0 ? t('downloads.remove.frees', { size: formatBytes(book.bytes) }) : '',
      ]
        .filter(Boolean)
        .join(' ')
    : '';
  return (
    <ConfirmDialog
      visible={!!book}
      title={t('downloads.remove.title')}
      message={message}
      confirmLabel={t('downloads.remove.confirm')}
      confirmIcon="trash"
      destructive
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
