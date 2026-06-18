import { router } from 'expo-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';

import { useAllProgress, useRecentBooks } from '@/api/hooks';
import { useApi } from '@/api/provider';
import type { Progress } from '@/api/types';
import { DownloadBadge } from '@/components/library/download-badge';
import { Cover } from '@/components/ui/cover';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { bookHref, pathLeaf } from '@/lib/paths';
import { flushQueue } from '@/playback/progress-sync';

const WIDE_BREAKPOINT = 1024;

// Grid sizing: pick as many columns as fit at a comfortable minimum card width,
// then divide the measured row width evenly (numeric widths avoid the flex-gap
// overflow that percentage widths hit on native).
const GRID_GAP = 12;
const MIN_CARD_WIDTH = 220;

function gridColumns(width: number) {
  return Math.max(2, Math.floor((width + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP)));
}

function Grid({ children }: { children: ReactNode }) {
  return (
    <View className="flex-row flex-wrap" style={{ gap: GRID_GAP }}>
      {children}
    </View>
  );
}

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
          <Text className="font-roboto-medium text-primary">{expanded ? 'Collapse' : 'See all'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A poster-style grid cell: square cover, title (with the download badge), and
 * an optional footer (e.g. a progress bar). */
function GridCard({
  libraryId,
  path,
  title,
  width,
  footer,
}: {
  libraryId: number;
  path: string;
  title: string;
  width: number;
  footer?: ReactNode;
}) {
  const api = useApi();
  return (
    <Pressable
      onPress={() => router.push(bookHref(libraryId, path))}
      style={{ width }}
      className="gap-2 rounded-lg border p-4 border-gray-200 bg-gray-50 shadow-sm dark:border-gray-860 dark:bg-gray-840 dark:shadow-none active:opacity-80"
    >
      <Cover
        source={{ uri: api.coverUrl(libraryId, path), headers: api.authHeaders() }}
        label={title}
        rounded="rounded-lg"
      />
      <View className="flex-row items-start gap-1.5">
        <Text variant="subtitle" numberOfLines={2} className="flex-1 h-10 items-center">
          {title}
        </Text>
        <View className="pt-0.5">
          <DownloadBadge libraryId={libraryId} path={path} />
        </View>
      </View>
      {footer}
    </Pressable>
  );
}

function ProgressCard({ item, width }: { item: Progress; width: number }) {
  const fraction = item.duration > 0 ? Math.min(1, item.position / item.duration) : 0;
  return (
    <GridCard
      libraryId={item.library_id}
      path={item.path}
      title={pathLeaf(item.path)}
      width={width}
      footer={
        !item.finished ? (
          <View className="h-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <View className="h-full rounded-full bg-primary" style={{ width: `${fraction * 100}%` }} />
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
  const { data: progress, isLoading, error, refetch } = useAllProgress();
  const {
    data: recentBooks,
    isLoading: recentLoading,
    error: recentError,
    refetch: refetchRecent,
  } = useRecentBooks();

  // Measure the content row so the grid columns track the available width (the
  // desktop sidebar means window width isn't the content width).
  const [gridWidth, setGridWidth] = useState(0);
  const columns = gridColumns(gridWidth);
  const cardWidth = gridWidth > 0 ? Math.floor((gridWidth - GRID_GAP * (columns - 1)) / columns) : 0;

  // Sections collapse to a single desktop row (the column count) / 4 on phone;
  // "See all" reveals the rest, "Collapse" hides them again.
  const sectionInitial = wide ? columns : 4;
  const [inProgressExpanded, setInProgressExpanded] = useState(false);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const recent = recentBooks ?? [];

  // Replay any saves captured while offline.
  useEffect(() => {
    void flushQueue(api);
  }, [api]);

  const { inProgress, finished } = useMemo(() => {
    const items = progress ?? [];
    const sorted = [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
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
    <ScrollView className="flex-1" contentContainerClassName="p-4">
      <View className="gap-6" onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
        <SectionHeader
          title="Continue listening"
          expanded={inProgressExpanded}
          hasMore={inProgressHasMore}
          onToggle={() => setInProgressExpanded((v) => !v)}
        />
        {isLoading ? <Spinner center /> : null}
        {error ? <ErrorNote message="Could not load your progress." onRetry={() => refetch()} /> : null}
        {!isLoading && !error && inProgress.length === 0 ? (
          <EmptyNote message="Start a book and it will show up here." />
        ) : null}
        {cardWidth > 0 && inProgress.length > 0 ? (
          <Grid>
            {visibleInProgress.map((item) => (
              <ProgressCard key={`${item.library_id}:${item.path}`} item={item} width={cardWidth} />
            ))}
          </Grid>
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
            {recentError ? <ErrorNote message="Could not load new books." onRetry={() => refetchRecent()} /> : null}
            {cardWidth > 0 && recent.length > 0 ? (
              <Grid>
                {visibleRecent.map((b) => (
                  <GridCard
                    key={`${b.library_id}:${b.rel_path}`}
                    libraryId={b.library_id}
                    path={b.rel_path}
                    title={b.title || pathLeaf(b.rel_path)}
                    width={cardWidth}
                  />
                ))}
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
                  <ProgressCard key={`${item.library_id}:${item.path}`} item={item} width={cardWidth} />
                ))}
              </Grid>
            ) : null}
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}
