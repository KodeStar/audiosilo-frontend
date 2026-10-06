import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/ui/empty-state';

import type { LibraryModeProps } from '../library-modes';

/**
 * The Library tab's Authors mode for the selected library. Placeholder: the Phase 2
 * authors screen replaces this body.
 */
export function AuthorsMode(_props: LibraryModeProps) {
  const { t } = useTranslation();
  return (
    <EmptyState icon="library" title={t('library.modes.authors')} hint={t('library.detail.soon')} />
  );
}
