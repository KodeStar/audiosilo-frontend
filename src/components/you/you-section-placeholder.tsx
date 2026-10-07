import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/ui/empty-state';
import type { IconName } from '@/components/ui/icon';
import type { YouSection } from '@/lib/paths';

import { youTitleKey } from './you-model';

const ICON: Record<'stats' | 'year' | 'account', IconName> = {
  stats: 'clock',
  year: 'sparkles',
  account: 'user',
};

/** A section of the You hub whose content lands with its own workstream (Your listening,
 * Year in listening, Account): a quiet "on its way" state, never an error. Removed once
 * every section is wired in (`you-hub.tsx`'s `SECTIONS`). */
export function YouSectionPlaceholder({
  section,
}: {
  section: Extract<YouSection, 'stats' | 'year' | 'account'>;
}) {
  const { t } = useTranslation();
  return (
    <EmptyState
      variant="card"
      icon={ICON[section]}
      title={t(youTitleKey(section))}
      hint={t('you.placeholder')}
    />
  );
}
