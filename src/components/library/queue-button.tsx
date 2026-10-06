import { useTranslation } from 'react-i18next';

import { Button, type ButtonProps } from '@/components/ui/button';

import { useQueueActions } from './use-queue-actions';

/**
 * "Queue it" / "Queued" for a book: adds it to the end of Up next on its own server,
 * or takes it off again (each with an Undo toast, `useQueueActions`). Renders nothing
 * unless that server advertises `queue`.
 */
export function QueueButton({
  connectionId,
  libraryId,
  path,
  variant = 'outline',
  size = 'default',
  className,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
  variant?: Extract<ButtonProps['variant'], 'outline' | 'ghost' | 'secondary'>;
  size?: Extract<ButtonProps['size'], 'sm' | 'default' | 'lg'>;
  className?: string;
}) {
  const { t } = useTranslation();
  const q = useQueueActions(connectionId);
  if (!q.supported) return null;
  const queued = q.isQueued(libraryId, path);
  return (
    <Button
      variant={variant}
      size={size}
      icon="list"
      loading={q.pending}
      title={queued ? t('queue.queued') : t('queue.queueIt')}
      accessibilityLabel={queued ? t('queue.removeLabel') : t('queue.addLabel')}
      onPress={() => void (queued ? q.unqueue(libraryId, path) : q.queue(libraryId, path))}
      className={className}
    />
  );
}
