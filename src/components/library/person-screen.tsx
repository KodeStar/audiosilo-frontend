import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { ContentScope } from '@/components/layout/content-scope';
import { PersonPage } from '@/components/series/person-page';
import type { PersonKind } from '@/components/series/people-mode';
import { EmptyState } from '@/components/ui/empty-state';
import { parsePersonParams } from '@/lib/paths';

/**
 * An author or narrator page: `/author?connection=&library=&name=` (`authorHref`) or
 * `/narrator?...` (`narratorHref`); `name` is the exact field value. Scoped to its own
 * `?connection=`; the page itself is `PersonPage`.
 */
export function PersonScreen({ kind }: { kind: PersonKind }) {
  return (
    <ContentScope>
      <PersonContent kind={kind} />
    </ContentScope>
  );
}

function PersonContent({ kind }: { kind: PersonKind }) {
  const { t } = useTranslation();
  const params = parsePersonParams(useLocalSearchParams());
  if (!params) return <EmptyState icon="library" title={t('library.detail.badLink')} />;
  return (
    <PersonPage
      key={`${params.libraryId}:${params.name}`}
      kind={kind}
      libraryId={params.libraryId}
      name={params.name}
    />
  );
}
