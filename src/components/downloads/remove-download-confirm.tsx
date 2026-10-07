import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { entryBytes } from '@/downloads/downloads-view';
import { useDownloadEntry, useDownloads } from '@/downloads/store';
import { formatBytes } from '@/lib/format';

/** A downloaded book to remove. */
export type RemoveDownloadTarget = {
  connectionId: string;
  libraryId: number;
  path: string;
  title: string;
};

/**
 * "Remove this download?": the one confirm for deleting a downloaded book, from the
 * Downloads page, the book page and a book's actions alike. Getting it back means
 * downloading it again, so it asks first and says how much room it frees (the
 * registry's `entryBytes`). Open while `target` is set; it removes the download itself,
 * then `onClose` (and `onRemoved`, for a caller that says so).
 */
export function RemoveDownloadConfirm({
  target,
  onClose,
  onRemoved,
}: {
  target: RemoveDownloadTarget | null;
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const { t } = useTranslation();
  const entry = useDownloadEntry(
    target?.connectionId ?? '',
    target?.libraryId ?? 0,
    target?.path ?? '',
  );
  const bytes = entry ? entryBytes(entry) : 0;
  const message = target
    ? [
        t('downloads.remove.message', { title: target.title }),
        bytes > 0 ? t('downloads.remove.frees', { size: formatBytes(bytes) }) : '',
      ]
        .filter(Boolean)
        .join(' ')
    : '';
  return (
    <ConfirmDialog
      visible={!!target}
      title={t('downloads.remove.title')}
      message={message}
      confirmLabel={t('downloads.remove.confirm')}
      confirmIcon="trash"
      destructive
      onCancel={onClose}
      onConfirm={() => {
        if (target) {
          void useDownloads.getState().remove(target.connectionId, target.libraryId, target.path);
        }
        onClose();
        onRemoved?.();
      }}
    />
  );
}
