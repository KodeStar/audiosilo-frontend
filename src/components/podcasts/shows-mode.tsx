import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { usePodcastShows } from '@/api/hooks';
import { CoverGrid, CoverGridSkeleton } from '@/components/library/cover-grid';
import type { LibraryModeProps } from '@/components/library/library-modes';
import { EmptyShelf } from '@/components/series/empty-shelf';
import { SubNavActions } from '@/components/shell/tab-root-nav';
import { ChipRow, FilterChip } from '@/components/ui/filter-chip';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';

import { FollowRequestsNotice, ShowsActions, useAddShowsAccess } from './shows-actions';
import { ShowTile } from './show-tile';

type ShowsFilter = 'all' | 'following';

/**
 * The Library tab's Shows mode for a podcast library (Bridge Phase 2d-1): the library's
 * shows as a cover grid (the server's title order), filtered to All or the ones the
 * listener follows. A tile opens the show page. Reading shows is core (no capability):
 * a podcast library is only listed to a player the server shows podcasts to. Its actions
 * (Bridge Phase 2d-2): Add shows and Export my shows (`ShowsActions`, in the sub-nav row on
 * tablet and desktop, above the grid on a phone), and a line while shows are being added.
 */
export function PodcastShowsMode({ connectionId, libraryId }: LibraryModeProps) {
  const phone = useLayout() === 'phone';
  return (
    <View className="flex-1">
      <View className={phone ? 'flex-row flex-wrap items-center gap-2 px-4' : 'px-4 lg:px-8'}>
        {/* Right here on a phone, the sub-nav row's end on tablet and desktop. */}
        <SubNavActions tab="(library)" id="shows-actions">
          <ShowsActions connectionId={connectionId} libraryId={libraryId} />
        </SubNavActions>
        <FollowRequestsNotice connectionId={connectionId} libraryId={libraryId} />
      </View>
      <ShowsBody connectionId={connectionId} libraryId={libraryId} />
    </View>
  );
}

function ShowsBody({ connectionId, libraryId }: LibraryModeProps) {
  const { t } = useTranslation();
  const { openPodcastShow, openFindShows } = useOpen();
  const shows = usePodcastShows(libraryId, connectionId);
  const canAdd = useAddShowsAccess(connectionId) === 'allowed';
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
    return (
      <EmptyShelf
        title={t('podcasts.shows.empty')}
        hint={t(canAdd ? 'podcasts.shows.addShowsHint' : 'podcasts.shows.emptyHint')}
        action={
          canAdd
            ? {
                label: t('podcasts.shows.addShows'),
                icon: 'plus',
                onPress: () => openFindShows(connectionId, libraryId),
              }
            : undefined
        }
      />
    );
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
