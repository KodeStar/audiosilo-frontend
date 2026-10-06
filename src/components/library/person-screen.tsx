import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { ContentScope } from '@/components/layout/content-scope';
import { parsePersonParams } from '@/lib/paths';

import { DetailPlaceholder } from './detail-placeholder';

export type PersonKind = 'author' | 'narrator';

/**
 * An author or narrator page: `/author?connection=&library=&name=` (`authorHref`) or
 * `/narrator?...` (`narratorHref`); `name` is the exact field value. Scoped to its own
 * `?connection=`. Placeholder until the Author/Narrator pages land (Phase 2).
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
  return (
    <DetailPlaceholder
      eyebrow={kind === 'author' ? t('library.detail.author') : t('library.detail.narrator')}
      title={params?.name}
      hint={params ? t('library.detail.soon') : t('library.detail.badLink')}
    />
  );
}
