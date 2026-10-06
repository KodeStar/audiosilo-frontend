import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { ContentScope } from '@/components/layout/content-scope';
import { parseCollectionParams } from '@/lib/paths';

import { DetailPlaceholder } from './detail-placeholder';

/**
 * A collection page: `/collection?connection=&id=` (`collectionHref`). Scoped to its
 * own `?connection=`. Placeholder until the Collections screen lands (Phase 2).
 */
export function CollectionScreen() {
  return (
    <ContentScope>
      <CollectionContent />
    </ContentScope>
  );
}

function CollectionContent() {
  const { t } = useTranslation();
  const params = parseCollectionParams(useLocalSearchParams());
  return (
    <DetailPlaceholder
      eyebrow={t('library.detail.collection')}
      hint={params ? t('library.detail.soon') : t('library.detail.badLink')}
    />
  );
}
