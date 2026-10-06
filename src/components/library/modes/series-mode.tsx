import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useSeriesList } from '@/api/hooks';
import { CardGrid } from '@/components/series/card-grid';
import { EmptyShelf } from '@/components/series/empty-shelf';
import { SeriesCard, SeriesCardSkeleton } from '@/components/series/series-card';
import { useProgressLookup } from '@/components/series/use-series-data';
import { useSession } from '@/stores/session';

import type { LibraryModeProps } from '../library-modes';

const SKELETON = [0, 1, 2, 3, 4, 5];

/**
 * The Library tab's Series mode for the selected library: a card per series (a mini
 * shelf of the listener's spines, name, author, length and progress) from the server's
 * series list, each opening the series page. The mode is only offered with
 * `browse_people`, so the list query always has a server that answers it.
 */
export function SeriesMode({ connectionId, libraryId }: LibraryModeProps) {
  const { t } = useTranslation();
  const list = useSeriesList(libraryId, connectionId);
  const { progressOf } = useProgressLookup();
  const connectionName = useSession(
    (s) => s.connections.find((c) => c.id === connectionId)?.name ?? '',
  );

  if (list.isPending) {
    return (
      <CardGrid
        testID="series-mode-loading"
        data={SKELETON}
        keyExtractor={String}
        renderItem={() => <SeriesCardSkeleton />}
        minWidth={300}
      />
    );
  }
  if (!list.data) {
    return (
      <EmptyShelf
        title={t('series.mode.errorTitle')}
        hint={t('series.error.hint')}
        action={{ label: t('common.retry'), icon: 'rotate', onPress: () => void list.refetch() }}
      />
    );
  }
  if (list.data.length === 0) {
    return (
      <EmptyShelf
        title={t('series.mode.emptyTitle')}
        hint={t('series.mode.emptyHint')}
        action={{
          label: t('series.mode.emptyAction'),
          onPress: () => router.setParams({ mode: undefined }),
        }}
      />
    );
  }
  return (
    <CardGrid
      data={list.data}
      keyExtractor={(s) => s.name}
      name={(s) => s.name}
      minWidth={300}
      renderItem={(s) => (
        <SeriesCard
          series={s}
          connectionId={connectionId}
          connectionName={connectionName}
          libraryId={libraryId}
          progressOf={progressOf}
        />
      )}
    />
  );
}
