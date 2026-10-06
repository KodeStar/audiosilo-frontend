import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/ui/empty-state';

import type { LibraryModeProps } from '../library-modes';

/**
 * The Library tab's Collections mode for the selected library. Placeholder: the Phase 2
 * collections screen replaces this body.
 */
export function CollectionsMode(_props: LibraryModeProps) {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="library"
      title={t('library.modes.collections')}
      hint={t('library.detail.soon')}
    />
  );
}
