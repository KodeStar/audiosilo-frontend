import { useTranslation } from 'react-i18next';

import { EmptyState, type EmptyStateProps } from '@/components/ui/empty-state';
import { useDownloads } from '@/downloads/store';

/**
 * An offline state's sentence: `hint` (what shows once a server answers), then where the
 * downloaded books are, only where this device can download. A browser on a plain http
 * origin has no Downloads (`engine.supported`), so it is not sent there (fe#179).
 */
export function useOfflineHint(hint: string): string {
  const { t } = useTranslation();
  const downloads = useDownloads((s) => s.supported);
  return downloads ? `${hint} ${t('common.offlineDownloads')}` : hint;
}

/**
 * The offline state of a page or a list (`offlineState` says when): "You're offline",
 * what shows once a server answers, and where the downloads are (`useOfflineHint`). Never
 * a Retry: the request is asked again by itself once the network is back. Without a
 * `hint` it is the title alone: a section of a page that is on screen (a downloaded
 * book's bookmarks), where sending the listener to Downloads would be wrong.
 */
export function OfflineState({
  hint,
  variant,
  className,
}: {
  hint?: string;
} & Pick<EmptyStateProps, 'variant' | 'className'>) {
  const { t } = useTranslation();
  const withDownloads = useOfflineHint(hint ?? '');
  return (
    <EmptyState
      icon="offline"
      title={t('common.offlineTitle')}
      hint={hint ? withDownloads : undefined}
      variant={variant}
      className={className}
    />
  );
}
