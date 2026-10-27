import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/ui/empty-state';

/** No library listed: none shared, or (`offline`) a list still waits for the network,
 * which is not "none shared" (fe#155). The Library tab's and Folders mode's empty state. */
export function NoLibrariesState({ offline }: { offline: boolean }) {
  const { t } = useTranslation();
  return offline ? (
    <EmptyState
      icon="offline"
      title={t('library.list.offlineTitle')}
      hint={t('library.list.offlineHint')}
    />
  ) : (
    <EmptyState
      icon="library"
      title={t('library.list.noLibraries')}
      hint={t('library.list.noLibrariesHint')}
    />
  );
}
