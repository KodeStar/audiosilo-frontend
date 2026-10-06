import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/ui/empty-state';

import type { LibraryModeProps } from '../library-modes';

/**
 * The Library tab's Series mode for the selected library. Placeholder: the Phase 2
 * series screen replaces this body.
 */
export function SeriesMode(_props: LibraryModeProps) {
  const { t } = useTranslation();
  return (
    <EmptyState icon="library" title={t('library.modes.series')} hint={t('library.detail.soon')} />
  );
}
