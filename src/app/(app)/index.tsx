import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';

import {
  useAllProgressAll,
  useFavouritesAll,
  useMarkFinished,
  useRecentAll,
  type SourcedProgress,
} from '@/api/hooks';
import { useApi } from '@/api/provider';
import { Grid, GRID_GAP, GridCard, gridColumns } from '@/components/library/poster-grid';
import { Icon } from '@/components/ui/icon';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { formatDuration, formatRelative } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { bookHref, parentPath, pathLeaf } from '@/lib/paths';
import { flushQueue } from '@/playback/progress-sync';
import { usePlayer } from '@/playback/store';
import { useSession } from '@/stores/session';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

const WIDE_BREAKPOINT = 1024;

/** Section heading with an optional "See all" / "Collapse" toggle (shown only
 * when there is more than the collapsed row holds). */
function SectionHeader({
  title,
  expanded,
  hasMore,
  onToggle,
}: {
  title: string;
  expanded?: boolean;
  hasMore?: boolean;
  onToggle?: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between">
      <Text variant="heading">{title}</Text>
      {hasMore && onToggle ? (
        <Pressable onPress={onToggle} hitSlop={8} className="active:opacity-70">
          <Text className="font-roboto-medium text-primary">
            {expanded ? 'Collapse' : 'See all'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Overflow menu for an in-progress book: mark finished, or jump to the
 * containing folder ("more in series"). */
function ProgressMenu({ item }: { item: SourcedProgress }) {
  const [open, setOpen] = useState(false);
  const markFinished = useMarkFinished(item.connectionId);
  const { openLibrary } = useOpen();
  const { scheme } = useTheme();
  const neutral = scheme === 'dark' ? colors.dark.text : colors.light.textMuted;

  const onMarkFinished = () => {
    setOpen(false);
    markFinished.mutate({
      libraryId: item.library_id,
      path: item.path,
      position: item.position,
      duration: item.duration,
      playback_speed: item.playback_speed,
    });
  };
  const onMoreInSeries = () => {
    setOpen(false);
    void openLibrary(item.connectionId, item.library_id, parentPath(item.path));
  };

  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={8} className="px-1 active:opacity-60">
        <Icon name="ellipsis" size={22} color={neutral} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable className="flex-1 justify-end bg-black/40" onPress={() => setOpen(false)}>
          <Pressable
            className="gap-1 rounded-t-2xl bg-gray-100 p-2 pb-6 dark:bg-gray-840"
            onPress={() => {}}
          >
            <MenuRow icon="check" label="Mark as Finished" onPress={onMarkFinished} />
            <MenuRow icon="library" label="More in series" onPress={onMoreInSeries} />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function MenuRow({
  icon,
  label,
  onPress,
}: {
  icon: 'check' | 'library';
  label: string;
  onPress: () => void;
}) {
  const { scheme } = useTheme();
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-lg px-4 py-3 active:bg-gray-200 dark:active:bg-gray-860"
    >
      <Icon name={icon} size={20} color={neutral} />
      <Text variant="title">{label}</Text>
    </Pressable>
  );
}

function ProgressCard({ item, width }: { item: SourcedProgress; width: number }) {
  const api = useApi(item.connectionId);
  const setActive = useSession((s) => s.setActiveConnection);
  const { width: screenWidth } = useWindowDimensions();
  const wide = screenWidth >= WIDE_BREAKPOINT;
  const fraction = item.duration > 0 ? Math.min(1, item.position / item.duration) : 0;
  const remaining = Math.max(0, item.duration - item.position);

  // Make this item's server active first (so the player chrome reads from it),
  // then on phone open the full-screen player modal, or on desktop resume in the
  // persistent player panel (fetch via the item's connection, start playback).
  const play = async () => {
    await setActive(item.connectionId);
    if (!wide) {
      // Land on the book page underneath the player (like tapping the cover does),
      // so closing the player returns there instead of back to Home.
      router.push(bookHref(item.library_id, item.path));
      router.push({
        pathname: '/player',
        params: { libraryId: String(item.library_id), path: item.path },
      });
      return;
    }
    const current = usePlayer.getState().nowPlaying;
    if (current?.libraryId === item.library_id && current?.path === item.path) return;
    const [book, chapterData] = await Promise.all([
      api.item(item.library_id, item.path),
      api.chapters(item.library_id, item.path),
    ]);
    await usePlayer.getState().playBook(api, item.library_id, book, chapterData);
  };
  return (
    <GridCard
      libraryId={item.library_id}
      path={item.path}
      title={pathLeaf(item.path)}
      connectionId={item.connectionId}
      width={width}
      footer={
        !item.finished ? (
          <View className="gap-1">
            <View className="flex-row items-center gap-2">
              <View className="h-1 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                <View
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${fraction * 100}%` }}
                />
              </View>
              <Pressable onPress={() => void play()} hitSlop={8} className="active:opacity-60">
                <Icon name="circle-play" size={26} color={colors.primary} />
              </Pressable>
              <ProgressMenu item={item} />
            </View>
            {remaining > 0 ? <Text variant="caption">{formatDuration(remaining)} left</Text> : null}
          </View>
        ) : (
          <Text variant="caption">Finished</Text>
        )
      }
    />
  );
}

export default function HomeScreen() {
  const api = useApi();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const { progress, isLoading, error } = useAllProgressAll();
  const { books: recent, isLoading: recentLoading, error: recentError } = useRecentAll();
  const { favourites } = useFavouritesAll();

  // Measure the content row so the grid columns track the available width (the
  // desktop sidebar means window width isn't the content width).
  const [gridWidth, setGridWidth] = useState(0);
  const columns = gridColumns(gridWidth);
  const cardWidth =
    gridWidth > 0 ? Math.floor((gridWidth - GRID_GAP * (columns - 1)) / columns) : 0;

  // Sections collapse to a single desktop row (the column count) / 4 on phone;
  // "See all" reveals the rest, "Collapse" hides them again.
  const sectionInitial = wide ? columns : 4;
  const [inProgressExpanded, setInProgressExpanded] = useState(false);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [favouritesExpanded, setFavouritesExpanded] = useState(false);
  // Only favourited books surface on home (cover cards); favourited folders live
  // on the Favourites shelf, not here.
  const favouriteBooks = favourites.filter((f) => f.is_book);
  const visibleFavourites = favouritesExpanded
    ? favouriteBooks
    : favouriteBooks.slice(0, sectionInitial);
  const favouritesHasMore = favouriteBooks.length > sectionInitial;

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

  const visibleInProgress = inProgressExpanded ? inProgress : inProgress.slice(0, sectionInitial);
  const inProgressHasMore = inProgress.length > sectionInitial;
  const visibleRecent = recentExpanded ? recent : recent.slice(0, sectionInitial);
  const recentHasMore = recent.length > sectionInitial;

  return (
    <ScrollView className="flex-1" contentContainerClassName="p-4 lg:px-8">
      <View className="gap-6" onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
        <SectionHeader
          title="Continue listening"
          expanded={inProgressExpanded}
          hasMore={inProgressHasMore}
          onToggle={() => setInProgressExpanded((v) => !v)}
        />
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
        {cardWidth > 0 && inProgress.length > 0 ? (
          <Grid>
            {visibleInProgress.map((item) => (
              <ProgressCard
                key={`${item.connectionId}:${item.library_id}:${item.path}`}
                item={item}
                width={cardWidth}
              />
            ))}
          </Grid>
        ) : null}

        {favouriteBooks.length > 0 ? (
          <>
            <SectionHeader
              title="Favourites"
              expanded={favouritesExpanded}
              hasMore={favouritesHasMore}
              onToggle={() => setFavouritesExpanded((v) => !v)}
            />
            {cardWidth > 0 ? (
              <Grid>
                {visibleFavourites.map((f) => (
                  <GridCard
                    key={`${f.connectionId}:${f.library_id}:${f.path}`}
                    libraryId={f.library_id}
                    path={f.path}
                    title={f.title || pathLeaf(f.path)}
                    author={f.author}
                    connectionId={f.connectionId}
                    width={cardWidth}
                  />
                ))}
              </Grid>
            ) : null}
          </>
        ) : null}

        {recentLoading || recentError || recent.length > 0 ? (
          <>
            <SectionHeader
              title="Recently added"
              expanded={recentExpanded}
              hasMore={recentHasMore}
              onToggle={() => setRecentExpanded((v) => !v)}
            />
            {recentLoading ? <Spinner center /> : null}
            {recentError && recent.length === 0 ? (
              <ErrorNote message="Could not load new books." />
            ) : null}
            {cardWidth > 0 && recent.length > 0 ? (
              <Grid>
                {visibleRecent.map((b) => {
                  const added = formatRelative(b.added_at);
                  return (
                    <GridCard
                      key={`${b.connectionId}:${b.library_id}:${b.rel_path}`}
                      libraryId={b.library_id}
                      path={b.rel_path}
                      title={b.title || pathLeaf(b.rel_path)}
                      author={b.author}
                      connectionId={b.connectionId}
                      width={cardWidth}
                      footer={added ? <Text variant="caption">Added {added}</Text> : undefined}
                    />
                  );
                })}
              </Grid>
            ) : null}
          </>
        ) : null}

        {finished.length > 0 ? (
          <>
            <SectionHeader title="Recently finished" />
            {cardWidth > 0 ? (
              <Grid>
                {finished.slice(0, 10).map((item) => (
                  <ProgressCard
                    key={`${item.connectionId}:${item.library_id}:${item.path}`}
                    item={item}
                    width={cardWidth}
                  />
                ))}
              </Grid>
            ) : null}
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}
