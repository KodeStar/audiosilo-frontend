import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { ContentScope } from '@/components/layout/content-scope';
import { parseSeriesParams } from '@/lib/paths';

import { DetailPlaceholder } from './detail-placeholder';

/**
 * The series page: `/series?connection=&library=&name=[&work=]` (`seriesHref`; see
 * `SeriesRef` for what `name` and `work` mean). Scoped to its own `?connection=`.
 * Placeholder until the series bookcase lands (Phase 2).
 */
export function SeriesScreen() {
  return (
    <ContentScope>
      <SeriesContent />
    </ContentScope>
  );
}

function SeriesContent() {
  const { t } = useTranslation();
  const params = parseSeriesParams(useLocalSearchParams());
  return (
    <DetailPlaceholder
      eyebrow={t('library.modes.series')}
      title={params?.name}
      hint={params ? t('library.detail.soon') : t('library.detail.badLink')}
    />
  );
}
