import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/ui/empty-state';

import type { LibraryModeProps } from '../library-modes';

/**
 * The Library tab's Narrators mode for the selected library. Placeholder: the Phase 2
 * narrators screen replaces this body.
 */
export function NarratorsMode(_props: LibraryModeProps) {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="library"
      title={t('library.modes.narrators')}
      hint={t('library.detail.soon')}
    />
  );
}
