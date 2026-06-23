import { router } from 'expo-router';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';

import {
  useAllProgressAll,
  useFavouritesAll,
  useRecentAll,
  type MergedBook,
  type SourcedFavourite,
  type SourcedProgress,
} from '@/api/hooks';
import { useApi } from '@/api/provider';
import { Grid, GRID_GAP, GridCard, gridColumns } from '@/components/library/poster-grid';
import { ProgressCard, progressKey } from '@/components/library/progress-card';
import { HorizontalShelf, SHELF_CARD_WIDTH } from '@/components/library/shelf';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { formatRelative } from '@/lib/format';
import { pathLeaf } from '@/lib/paths';
import { flushQueue } from '@/playback/progress-sync';

const WIDE_BREAKPOINT = 1024;
// Recently added / finished cap on home; the rest live on the /browse page.
const HOME_SHELF_LIMIT = 15;

/** Section heading with an optional "View more" link (to the browse page) or a
 * "See all" / "Collapse" toggle (inline expand, used by Favourites on desktop). */
function SectionHeader({
  title,
  expanded,
  hasMore,
  onToggle,
  onViewMore,
}: {
  title: string;
  expanded?: boolean;
  hasMore?: boolean;
  onToggle?: () => void;
  onViewMore?: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between">
      <Text variant="heading">{title}</Text>
      {onViewMore ? (
        <Pressable onPress={onViewMore} hitSlop={8} className="active:opacity-70">
          <Text className="font-roboto-medium text-primary">View more</Text>
        </Pressable>
      ) : hasMore && onToggle ? (
        <Pressable onPress={onToggle} hitSlop={8} className="active:opacity-70">
          <Text className="font-roboto-medium text-primary">
            {expanded ? 'Collapse' : 'See all'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const bookKey = (b: MergedBook) => `${b.connectionId}:${b.library_id}:${b.rel_path}`;
const favKey = (f: SourcedFavourite) => `${f.connectionId}:${f.library_id}:${f.path}`;

export default function HomeScreen() {
  const api = useApi();
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

  // Replay any saves captured while offline.
  useEffect(() => {
    void flushQueue(api);
  }, [api]);

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
        footer={added ? <Text variant="caption">Added {added}</Text> : undefined}
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
          <SectionHeader title="Continue listening" />
          {isLoading ? <Spinner center /> : null}
          {/* Only surface the error when it actually left us with nothing to show.
              The aggregate hook flags an error if *any* connection (or a background
              refetch) failed, even while cached books are still on screen. */}
          {error && inProgress.length === 0 ? (
            <ErrorNote message="Could not load your progress." />
          ) : null}
          {!isLoading && !error && inProgress.length === 0 ? (
            <EmptyNote message="Start a book and it will show up here." />
          ) : null}
          {inProgress.length > 0 ? shelfBody(inProgress, progressKey, progressCard) : null}
        </View>

        {favouriteBooks.length > 0 ? (
          <View className="gap-3">
            <SectionHeader
              title="Favourites"
              expanded={favouritesExpanded}
              hasMore={wide && favouritesHasMore}
              onToggle={() => setFavouritesExpanded((v) => !v)}
            />
            {shelfBody(wide ? visibleFavourites : favouriteBooks, favKey, favouriteCard)}
          </View>
        ) : null}

        {recentLoading || recentError || recent.length > 0 ? (
          <View className="gap-3">
            <SectionHeader
              title="Recently added"
              onViewMore={recent.length > 0 ? () => router.push('/browse?type=recent') : undefined}
            />
            {recentLoading ? <Spinner center /> : null}
            {recentError && recent.length === 0 ? (
              <ErrorNote message="Could not load new books." />
            ) : null}
            {recent.length > 0 ? shelfBody(recentItems, bookKey, recentCard) : null}
          </View>
        ) : null}

        {finished.length > 0 ? (
          <View className="gap-3">
            <SectionHeader
              title="Recently finished"
              onViewMore={() => router.push('/browse?type=finished')}
            />
            {shelfBody(finishedItems, progressKey, progressCard)}
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}
