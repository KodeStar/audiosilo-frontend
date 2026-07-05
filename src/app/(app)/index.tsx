import { router } from 'expo-router';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, useWindowDimensions, View } from 'react-native';

import {
  useAllProgressAll,
  useFavouritesAll,
  useRecentAll,
  type MergedBook,
  type SourcedFavourite,
  type SourcedProgress,
} from '@/api/hooks';
import {
  Grid,
  GRID_GAP,
  GridCard,
  GridCardSkeleton,
  gridColumns,
} from '@/components/library/poster-grid';
import { ProgressCard, progressKey } from '@/components/library/progress-card';
import { HorizontalShelf, SHELF_CARD_WIDTH } from '@/components/library/shelf';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNote } from '@/components/ui/query-state';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { formatRelative } from '@/lib/format';
import { WIDE_BREAKPOINT } from '@/lib/layout';
import { pathLeaf } from '@/lib/paths';
import { flushQueue } from '@/playback/progress-sync';

// Recently added / finished cap on home; the rest live on the /browse page.
const HOME_SHELF_LIMIT = 15;

const bookKey = (b: MergedBook) => `${b.connectionId}:${b.library_id}:${b.rel_path}`;
const favKey = (f: SourcedFavourite) => `${f.connectionId}:${f.library_id}:${f.path}`;

export default function HomeScreen() {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const { progress, isLoading, error } = useAllProgressAll();
  const { books: recent, isLoading: recentLoading, error: recentError } = useRecentAll();
  const { favourites } = useFavouritesAll();
  const paddingBottom = useMiniPlayerInset();

  // Measure the content row so the desktop grid columns track the available width
  // (the sidebar means window width isn't the content width). Phone uses shelves.
  const [gridWidth, setGridWidth] = useState(0);
  const columns = gridColumns(gridWidth);
  const cardWidth =
    gridWidth > 0 ? Math.floor((gridWidth - GRID_GAP * (columns - 1)) / columns) : 0;

  // Favourites keep an inline "See all" expand on desktop (collapsed to one row).
  const [favouritesExpanded, setFavouritesExpanded] = useState(false);
  const favouriteBooks = favourites.filter((f) => f.is_book);
  const visibleFavourites = favouritesExpanded ? favouriteBooks : favouriteBooks.slice(0, columns);
  const favouritesHasMore = favouriteBooks.length > columns;

  // Replay any saves captured while offline (each entry routes to its own server).
  useEffect(() => {
    void flushQueue();
  }, []);

  const { inProgress, finished } = useMemo(() => {
    const sorted = [...progress].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return {
      inProgress: sorted.filter((p) => !p.finished && p.position > 0),
      finished: sorted.filter((p) => p.finished),
    };
  }, [progress]);

  const recentItems = recent.slice(0, HOME_SHELF_LIMIT);
  const finishedItems = finished.slice(0, HOME_SHELF_LIMIT);

  // Render a shelf body: a virtualized horizontal row on phone, the wrapping grid
  // on desktop. (Width comes from cardWidth on desktop, SHELF_CARD_WIDTH on phone.)
  const shelfBody = <T,>(
    items: T[],
    keyExtractor: (it: T) => string,
    renderCard: (it: T, w: number) => ReactElement,
  ) =>
    wide ? (
      cardWidth > 0 ? (
        <Grid>
          {items.map((it) => (
            <View key={keyExtractor(it)} style={{ width: cardWidth }}>
              {renderCard(it, cardWidth)}
            </View>
          ))}
        </Grid>
      ) : null
    ) : (
      <HorizontalShelf
        data={items}
        keyExtractor={keyExtractor}
        renderCard={(it) => renderCard(it, SHELF_CARD_WIDTH)}
      />
    );

  // Loading placeholder mirroring a shelf/grid row: cover-shaped skeletons + text
  // lines. Phone renders an edge-to-edge row; desktop a full grid row. `footer`
  // adds the extra progress line for the Continue Listening shelf.
  const shelfSkeleton = (footer?: boolean) =>
    wide ? (
      cardWidth > 0 ? (
        <Grid>
          {Array.from({ length: columns }).map((_, i) => (
            <GridCardSkeleton key={i} width={cardWidth} footer={footer} />
          ))}
        </Grid>
      ) : null
    ) : (
      <View className="flex-row gap-3 overflow-hidden">
        {Array.from({ length: 3 }).map((_, i) => (
          <GridCardSkeleton key={i} width={SHELF_CARD_WIDTH} footer={footer} />
        ))}
      </View>
    );

  const progressCard = (it: SourcedProgress, w: number) => <ProgressCard item={it} width={w} />;
  const recentCard = (b: MergedBook, w: number) => {
    const added = formatRelative(b.added_at);
    return (
      <GridCard
        libraryId={b.library_id}
        path={b.rel_path}
        title={b.title || pathLeaf(b.rel_path)}
        author={b.author}
        connectionId={b.connectionId}
        width={w}
        footer={
          added ? <Text variant="caption">{t('home.added', { when: added })}</Text> : undefined
        }
      />
    );
  };
  const favouriteCard = (f: SourcedFavourite, w: number) => (
    <GridCard
      libraryId={f.library_id}
      path={f.path}
      title={f.title || pathLeaf(f.path)}
      author={f.author}
      connectionId={f.connectionId}
      width={w}
    />
  );

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="p-4 lg:px-8"
      contentContainerStyle={{ paddingBottom }}
    >
      <View className="gap-6" onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
        <View className="gap-3">
          <SectionHeader title={t('home.continueListening')} />
          {isLoading && inProgress.length === 0 ? shelfSkeleton(true) : null}
          {/* Only surface the error when it actually left us with nothing to show.
              The aggregate hook flags an error if *any* connection (or a background
              refetch) failed, even while cached books are still on screen. */}
          {error && inProgress.length === 0 ? (
            <ErrorNote message={t('home.progressError')} />
          ) : null}
          {!isLoading && !error && inProgress.length === 0 ? (
            <EmptyState
              icon="book"
              title={t('home.continueEmptyTitle')}
              hint={t('home.continueEmpty')}
            />
          ) : null}
          {inProgress.length > 0 ? shelfBody(inProgress, progressKey, progressCard) : null}
        </View>

        {favouriteBooks.length > 0 ? (
          <View className="gap-3">
            <SectionHeader
              title={t('home.favourites')}
              action={
                wide && favouritesHasMore
                  ? {
                      label: favouritesExpanded ? t('home.collapse') : t('home.seeAll'),
                      onPress: () => setFavouritesExpanded((v) => !v),
                    }
                  : undefined
              }
            />
            {shelfBody(wide ? visibleFavourites : favouriteBooks, favKey, favouriteCard)}
          </View>
        ) : null}

        {recentLoading || recentError || recent.length > 0 ? (
          <View className="gap-3">
            <SectionHeader
              title={t('home.recentlyAdded')}
              action={
                recent.length > 0
                  ? { label: t('home.viewMore'), onPress: () => router.push('/browse?type=recent') }
                  : undefined
              }
            />
            {recentLoading && recent.length === 0 ? shelfSkeleton() : null}
            {recentError && recent.length === 0 ? (
              <ErrorNote message={t('home.recentError')} />
            ) : null}
            {recent.length > 0 ? shelfBody(recentItems, bookKey, recentCard) : null}
          </View>
        ) : null}

        {finished.length > 0 ? (
          <View className="gap-3">
            <SectionHeader
              title={t('home.recentlyFinished')}
              action={{
                label: t('home.viewMore'),
                onPress: () => router.push('/browse?type=finished'),
              }}
            />
            {shelfBody(finishedItems, progressKey, progressCard)}
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}
