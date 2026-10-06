import { useTranslation } from 'react-i18next';

import { Button, type ButtonProps } from '@/components/ui/button';

import { useQueueActions } from './use-queue-actions';

/**
 * "Queue it" / "Queued" for a book: adds it to the end of Up next on its own server,
 * or takes it off again (each with an Undo toast, `useQueueActions`). Renders nothing
 * unless that server advertises `queue`. `title` names the book in the accessible name,
 * for a list of these buttons (the series page's entries).
 */
export function QueueButton({
  connectionId,
  libraryId,
  path,
  title,
  variant = 'outline',
  size = 'default',
  className,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
  title?: string;
  variant?: Extract<ButtonProps['variant'], 'default' | 'outline' | 'ghost' | 'secondary'>;
  size?: Extract<ButtonProps['size'], 'sm' | 'default' | 'lg'>;
  className?: string;
}) {
  const { t } = useTranslation();
  const q = useQueueActions(connectionId);
  if (!q.supported) return null;
  const queued = q.isQueued(libraryId, path);
  const label = queued ? t('queue.queued') : t('queue.queueIt');
  return (
    <Button
      variant={variant}
      size={size}
      icon="queue"
      loading={q.pending}
      title={label}
      // The visible words lead the name (and the book follows); the hint says what a
      // press does, since "Queued" is a state.
      accessibilityLabel={[label, title].filter(Boolean).join(', ')}
      accessibilityHint={queued ? t('queue.removeLabel') : t('queue.addLabel')}
      onPress={() => void (queued ? q.unqueue(libraryId, path) : q.queue(libraryId, path))}
      className={className}
    />
  );
}
