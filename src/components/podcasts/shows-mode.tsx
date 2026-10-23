import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { usePodcastShows } from '@/api/hooks';
import { CoverGrid, CoverGridSkeleton } from '@/components/library/cover-grid';
import type { LibraryModeProps } from '@/components/library/library-modes';
import { EmptyShelf } from '@/components/series/empty-shelf';
import { ChipRow, FilterChip } from '@/components/ui/filter-chip';
import { useOpen } from '@/lib/open';

import { ShowTile } from './show-tile';

type ShowsFilter = 'all' | 'following';

/**
 * The Library tab's Shows mode for a podcast library (Bridge Phase 2d-1): the library's
 * shows as a cover grid (the server's title order), filtered to All or the ones the
 * listener follows. A tile opens the show page. Reading shows is core (no capability):
 * a podcast library is only listed to a player the server shows podcasts to.
 */
export function PodcastShowsMode({ connectionId, libraryId }: LibraryModeProps) {
  const { t } = useTranslation();
  const { openPodcastShow } = useOpen();
  const shows = usePodcastShows(libraryId, connectionId);
  const [filter, setFilter] = useState<ShowsFilter>('all');

  if (shows.isPending) {
    return (
      <View testID="shows-mode-loading">
        <CoverGridSkeleton />
      </View>
    );
  }
  if (!shows.data) {
    return (
      <EmptyShelf
        title={t('podcasts.shows.loadError')}
        action={{ label: t('common.retry'), icon: 'rotate', onPress: () => void shows.refetch() }}
      />
    );
  }
  if (shows.data.length === 0) {
    return <EmptyShelf title={t('podcasts.shows.empty')} hint={t('podcasts.shows.emptyHint')} />;
  }
  const following = shows.data.filter((s) => s.following);
  const list = filter === 'following' ? following : shows.data;
  return (
    <CoverGrid
      data={list}
      keyExtractor={(s) => s.path}
      renderItem={(show, width) => (
        <ShowTile
          connectionId={connectionId}
          show={show}
          width={width}
          onPress={() => openPodcastShow(connectionId, libraryId, show.path)}
        />
      )}
      ListHeaderComponent={
        <ChipRow accessibilityLabel={t('podcasts.shows.filterLabel')}>
          <FilterChip
            label={t('podcasts.shows.all')}
            count={shows.data.length}
            selected={filter === 'all'}
            onPress={() => setFilter('all')}
          />
          <FilterChip
            label={t('podcasts.shows.following')}
            count={following.length}
            selected={filter === 'following'}
            onPress={() => setFilter('following')}
          />
        </ChipRow>
      }
    />
  );
}
