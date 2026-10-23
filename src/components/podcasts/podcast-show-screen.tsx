import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';

import { useCapability, usePodcastEpisodes, usePodcastShows, useProgressLookup } from '@/api/hooks';
import { useScopedCid } from '@/api/provider';
import type { PodcastEpisodeOrder, PodcastShow } from '@/api/types';
import { ContentScope } from '@/components/layout/content-scope';
import { BookCover } from '@/components/library/book-cover';
import { pageGutter } from '@/components/library/cover-layout';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { useLayout } from '@/lib/layout';
import { parsePodcastParams } from '@/lib/paths';
import { usePageTitle } from '@/lib/use-page-title';

import { EpisodeRow } from './episode-row';
import { FollowButton } from './follow-button';
import { defaultEpisodeOrder, visibleEpisodes } from './podcast-model';

/**
 * A podcast show's page (Bridge Phase 2d-1):
 * `/podcast?connection=&library=&show=<path>[&order=]` (`podcastShowHref`), scoped to its
 * own `?connection=`. The show comes from its library's show list (the cached one when the
 * Library's Shows mode read it); its episodes page in, in the server's order.
 */
export function PodcastShowScreen() {
  return (
    <ContentScope>
      <ShowContent />
    </ContentScope>
  );
}

function ShowContent() {
  const { t } = useTranslation();
  const params = parsePodcastParams(useLocalSearchParams());
  const cid = useScopedCid();
  const shows = usePodcastShows(params?.libraryId ?? 0, cid, { enabled: !!params });
  const show = params ? shows.data?.find((s) => s.path === params.show) : undefined;
  usePageTitle(show?.title);
  if (!params) return <EmptyState icon="microphone" title={t('library.detail.badLink')} />;
  if (shows.isPending) {
    return (
      <View className="p-4">
        <RowSkeletonList />
      </View>
    );
  }
  if (!shows.data) {
    return (
      <EmptyState
        icon="microphone"
        title={t('podcasts.show.loadError')}
        action={{ label: t('common.retry'), icon: 'rotate', onPress: () => void shows.refetch() }}
      />
    );
  }
  if (!show) {
    return (
      <EmptyState
        icon="microphone"
        title={t('podcasts.show.notFound')}
        hint={t('podcasts.show.notFoundHint')}
      />
    );
  }
  return (
    <ShowPage
      key={`${params.libraryId}:${show.path}`}
      connectionId={cid}
      show={show}
      order={params.order ?? defaultEpisodeOrder(show)}
      onGone={() => {
        void shows.refetch();
        if (router.canGoBack()) router.back();
      }}
    />
  );
}

function ShowPage({
  connectionId,
  show,
  order,
  onGone,
}: {
  connectionId: string;
  show: PodcastShow;
  order: PodcastEpisodeOrder;
  onGone: () => void;
}) {
  const { t } = useTranslation();
  const gutter = pageGutter(useLayout());
  const paddingBottom = useMiniPlayerInset();
  const episodes = usePodcastEpisodes(show.library_id, show.path, order, connectionId);
  const { progressOf } = useProgressLookup();
  const canFetch = useCapability('podcast_fetch', connectionId);
  const rows = useMemo(
    () => visibleEpisodes(episodes.data?.pages.flatMap((p) => p.episodes) ?? []),
    [episodes.data],
  );
  const now = new Date();

  const empty = episodes.isPending ? (
    <RowSkeletonList />
  ) : episodes.isError && !episodes.data ? (
    <EmptyState
      title={t('podcasts.show.loadError')}
      action={{ label: t('common.retry'), icon: 'rotate', onPress: () => void episodes.refetch() }}
    />
  ) : (
    <EmptyState icon="microphone" title={t('podcasts.show.noEpisodes')} />
  );

  return (
    <FlatList
      data={rows}
      keyExtractor={(e) => e.path}
      renderItem={({ item }) => (
        <EpisodeRow
          connectionId={connectionId}
          show={show}
          episode={item}
          progress={progressOf(connectionId, show.library_id, item.path)}
          canFetch={canFetch}
          now={now}
        />
      )}
      ListHeaderComponent={
        <ShowHero connectionId={connectionId} show={show} order={order} onGone={onGone} />
      }
      ListEmptyComponent={empty}
      ListFooterComponent={
        episodes.isFetchingNextPage ? (
          <View className="items-center py-4" accessibilityLabel={t('podcasts.show.loadingMore')}>
            <Spinner />
          </View>
        ) : null
      }
      onEndReached={() => {
        if (episodes.hasNextPage && !episodes.isFetchingNextPage) void episodes.fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
      contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom }}
    />
  );
}

/** The show's head: cover, title, author, the episode count, Private feed, Follow, a
 * failed last check, the description (collapsed past a few lines) and the order. */
function ShowHero({
  connectionId,
  show,
  order,
  onGone,
}: {
  connectionId: string;
  show: PodcastShow;
  order: PodcastEpisodeOrder;
  onGone: () => void;
}) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  return (
    <View testID="podcast-show-hero" className="gap-4 pb-2 pt-5">
      <View className={phone ? 'items-center gap-4' : 'flex-row items-end gap-6'}>
        <BookCover
          connectionId={connectionId}
          libraryId={show.library_id}
          path={show.path}
          coverVersion={show.cover_version}
          width={phone ? 180 : 200}
          title={show.title}
          author={show.author}
          shadow="lg"
        />
        <View className={phone ? 'items-center gap-2' : 'min-w-0 flex-1 gap-2'}>
          <Text variant="display" className={phone ? 'text-center' : undefined}>
            {show.title}
          </Text>
          {show.author ? <Text variant="muted">{show.author}</Text> : null}
          <View className="flex-row flex-wrap items-center gap-2">
            <Text variant="caption">
              {t('podcasts.show.episodes', { count: show.episode_count })}
            </Text>
            {show.private ? (
              <Badge variant="outline">
                <Text>{t('podcasts.shows.privateBadge')}</Text>
              </Badge>
            ) : null}
          </View>
          {show.status.error ? (
            <Text variant="caption" testID="podcast-last-check-failed">
              {t('podcasts.show.lastCheckFailed')}
            </Text>
          ) : null}
          <View className="flex-row pt-1">
            <FollowButton connectionId={connectionId} show={show} onGone={onGone} />
          </View>
        </View>
      </View>
      {show.description ? (
        <View className="gap-1">
          <Text
            variant="body"
            numberOfLines={expanded ? undefined : 4}
            onTextLayout={(e) => {
              if (!expanded && e.nativeEvent.lines.length >= 4) setClamped(true);
            }}
          >
            {show.description}
          </Text>
          {clamped ? (
            <Button
              variant="link"
              title={expanded ? t('book.meta.showLess') : t('book.meta.showMore')}
              onPress={() => setExpanded((v) => !v)}
              className="self-start"
            />
          ) : null}
        </View>
      ) : null}
      <SegmentedControl
        options={[
          { value: 'newest', label: t('podcasts.show.newestFirst') },
          { value: 'oldest', label: t('podcasts.show.oldestFirst') },
        ]}
        value={order}
        onChange={(next) => router.setParams({ order: next })}
        accessibilityLabel={t('podcasts.show.orderLabel')}
        className="self-start"
      />
    </View>
  );
}
