import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/ui/empty-state';

import type { LibraryModeProps } from '../library-modes';

/**
 * The Library tab's Books mode for the selected library. Placeholder: the Phase 2
 * books screen replaces this body.
 */
export function BooksMode(_props: LibraryModeProps) {
  const { t } = useTranslation();
  return (
    <EmptyState icon="library" title={t('library.modes.books')} hint={t('library.detail.soon')} />
  );
}
