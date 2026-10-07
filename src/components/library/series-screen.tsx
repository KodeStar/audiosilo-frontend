import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { ContentScope } from '@/components/layout/content-scope';
import { SeriesPage, WorkSeriesPage } from '@/components/series/series-page';
import { EmptyState } from '@/components/ui/empty-state';
import { parseSeriesParams } from '@/lib/paths';

/**
 * The series page: `/series?connection=&library=&name=[&work=]` (`seriesHref`; see
 * `SeriesRef` for what `name` and `work` mean). Scoped to its own `?connection=`. A
 * local series (`name`) is the bookcase (`SeriesPage`); a link naming only a community
 * work shows what the metadata knows of it (`WorkSeriesPage`).
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
  if (!params) return <EmptyState icon="library" title={t('library.detail.badLink')} />;
  if (params.name) {
    return (
      <SeriesPage
        // A different series is a fresh page (its own selection and scroll).
        key={`${params.libraryId}:${params.name}`}
        libraryId={params.libraryId}
        name={params.name}
        work={params.work}
      />
    );
  }
  return <WorkSeriesPage workId={params.work!} />;
}
