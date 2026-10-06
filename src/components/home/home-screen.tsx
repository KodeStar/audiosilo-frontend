import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import {
  qk,
  type SourcedFavourite,
  type SourcedProgress,
  useAllProgressAll,
  useFavouritesAll,
  useRecentAll,
} from '@/api/hooks';
import { CoverTile, useServerFlag } from '@/components/library/cover-tile';
import { libraryModeHref } from '@/components/library/library-modes';
import { ShelfRow } from '@/components/library/shelf-row';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { formatRelative } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import type { MergedBook } from '@/lib/dedup';
import { bookTitle } from '@/lib/paths';
import { flushQueue } from '@/playback/progress-sync';
import { usePlayer } from '@/playback/store';
import { useSession } from '@/stores/session';

import { ProgressTile } from './book-title';
import { Greeting } from './greeting';
import {
  type BookAt,
  keyOf,
  libraryBooksHref,
  nextCandidates,
  nextInSeriesItems,
  pickNowBook,
  progressAt,
  smartShelves,
  splitProgress,
} from './home-model';
import { HomeSection } from './home-section';
import { NowEmpty, NowError } from './home-states';
import { NextInSeriesRow, ShelfSkeleton } from './next-in-series';
import { NowCard, NowCardSkeleton } from './now-card';
import { SmartShelves } from './smart-shelves';
import { ThisWeekCard } from './this-week-card';
import { useNarratorShelf } from './use-narrator-shelf';
import { useNextInSeries } from './use-next-in-series';
import { useSyncPill } from './use-sync-pill';

/** Recently added / finished / favourites on Home; the rest live on their own pages. */
const SHELF_LIMIT = 15;

const progressKey = (p: SourcedProgress) => keyOf(progressAt(p));
const bookKey = (b: MergedBook) =>
  keyOf({ connectionId: b.connectionId, libraryId: b.library_id, path: b.rel_path });
const favouriteKey = (f: SourcedFavourite) =>
  keyOf({ connectionId: f.connectionId, libraryId: f.library_id, path: f.path });

/**
 * Home (STYLEGUIDE section 2, the Stacks Home): the greeting, the Now card (with This
 * week beside it on a desktop), Continue listening, Next in your series, This week
 * (tablet and phone), smart shelves, then Recently added, Favourites and Recently
 * finished. Aggregated across every signed-in server; each book keeps its own.
 */
export function HomeScreen() {
  const { t } = useTranslation();
  const layout = useLayout();
  const desktop = layout === 'desktop';
  const paddingBottom = useMiniPlayerInset();
  const qc = useQueryClient();

  const connections = useSession((s) => s.connections);
  const defaultCid = useSession((s) => s.defaultConnectionId);
  const user = useSession((s) => s.user);
  const { progress, isLoading, error } = useAllProgressAll();
  const recent = useRecentAll();
  const { favourites } = useFavouritesAll();
  const np = usePlayer((s) => s.nowPlaying);

  // The progress overflow menu (mark finished, open the folder), opened by a long
  // press on a Continue listening cover; one sheet at the screen root.
  // "Added this week" is counted from when Home opened.
  const [mountedAt] = useState(Date.now);

  // Replay any saves captured while offline (each entry routes to its own server).
  useEffect(() => {
    void flushQueue();
  }, []);

  const { inProgress, finished } = useMemo(() => splitProgress(progress), [progress]);
  const loaded: BookAt | null = np
    ? { connectionId: np.connectionId, libraryId: np.libraryId, path: np.path }
    : null;
  const nowAt = pickNowBook(loaded, inProgress);
  const nowKey = nowAt ? keyOf(nowAt) : null;
  const nowSaved = nowKey ? progress.find((p) => progressKey(p) === nowKey) : undefined;
  const continuing = inProgress.filter((p) => progressKey(p) !== nowKey);

  const next = useNextInSeries(nextCandidates(nowAt, inProgress, finished));
  // A next book already on Home (on the Now card, in progress or finished) isn't news.
  const skipNext = new Set(progress.filter((p) => p.finished || p.position > 0).map(progressKey));
  if (nowKey) skipNext.add(nowKey);
  const nextItems = nextInSeriesItems(next.answers, skipNext);

  const narrator = useNarratorShelf(defaultCid, inProgress);
  const shelves = smartShelves({
    inProgress,
    recent: recent.books,
    narrator,
    now: mountedAt,
  });

  const sync = useSyncPill(progress[0]?.updated_at);
  const serverLabel = useServerFlag();

  const retryProgress = () => void qc.refetchQueries({ queryKey: qk.allProgressAll() });

  // The hero: the Now card, its skeleton while progress first loads, the error when
  // that failed with nothing to show, or the empty state.
  const hero = nowAt ? (
    <NowCard at={nowAt} saved={nowSaved} />
  ) : isLoading ? (
    <NowCardSkeleton />
  ) : error ? (
    <NowError onRetry={retryProgress} />
  ) : (
    <NowEmpty />
  );

  const progressTile = (p: SourcedProgress, width: number) => (
    <ProgressTile item={p} width={width} server={serverLabel(p.connectionId)} />
  );

  const recentBooks = recent.books.slice(0, SHELF_LIMIT);
  const favouriteBooks = favourites.filter((f) => f.is_book).slice(0, SHELF_LIMIT);
  const finishedItems = finished.slice(0, SHELF_LIMIT);

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-10 px-4 pt-4 md:pt-6 lg:px-8 lg:pt-9"
        contentContainerStyle={{ paddingBottom }}
      >
        <View className="gap-[22px]">
          <Greeting name={user?.username} sync={sync} servers={connections.length} />
          {desktop ? (
            <View className="flex-row items-stretch gap-5">
              <View className="min-w-0 flex-1">{hero}</View>
              <ThisWeekCard className="w-[300px]" />
            </View>
          ) : (
            hero
          )}
        </View>

        {continuing.length > 0 || (isLoading && progress.length === 0) ? (
          <HomeSection
            title={t('home.continueListening')}
            sub={
              continuing.length > 0
                ? t('home.continueMore', { count: continuing.length })
                : undefined
            }
            action={{
              label: t('home.allInProgress'),
              onPress: () => router.push(libraryBooksHref({ status: 'progress' })),
            }}
          >
            {continuing.length > 0 ? (
              <ShelfRow
                data={continuing}
                keyExtractor={progressKey}
                renderItem={progressTile}
                accessibilityLabel={t('home.continueListening')}
              />
            ) : (
              <ShelfSkeleton />
            )}
          </HomeSection>
        ) : null}

        {!desktop ? <ThisWeekCard /> : null}

        {next.supported && (nextItems.length > 0 || next.isLoading) ? (
          <HomeSection
            title={t('home.next.title')}
            sub={t('home.next.sub')}
            action={{
              label: t('home.next.allSeries'),
              onPress: () => router.push(libraryModeHref('series')),
            }}
          >
            {nextItems.length > 0 ? (
              <NextInSeriesRow items={nextItems} labelFor={serverLabel} />
            ) : (
              <ShelfSkeleton />
            )}
          </HomeSection>
        ) : null}

        {shelves.length > 0 ? (
          <HomeSection title={t('home.smart.title')} sub={t('home.smart.sub')}>
            <SmartShelves shelves={shelves} />
          </HomeSection>
        ) : null}

        {recent.isLoading || recent.books.length > 0 || recent.error ? (
          <HomeSection
            title={t('home.recentlyAdded')}
            sub={connections.length > 1 ? t('home.acrossServers') : undefined}
            action={
              recent.books.length > 0
                ? {
                    label: t('home.seeAll'),
                    onPress: () => router.push(libraryBooksHref({ sort: 'recent' })),
                  }
                : undefined
            }
          >
            {recentBooks.length > 0 ? (
              <ShelfRow
                data={recentBooks}
                keyExtractor={bookKey}
                accessibilityLabel={t('home.recentlyAdded')}
                renderItem={(b, width) => {
                  const added = formatRelative(b.added_at);
                  return (
                    <CoverTile
                      connectionId={b.connectionId}
                      libraryId={b.library_id}
                      path={b.rel_path}
                      title={bookTitle(b.title, b.rel_path)}
                      book={b}
                      author={b.author}
                      caption={added ? t('home.added', { when: added }) : b.author}
                      coverVersion={b.cover_version}
                      server={serverLabel(b.connectionId)}
                      width={width}
                      onShelf
                    />
                  );
                }}
              />
            ) : recent.isLoading ? (
              <ShelfSkeleton />
            ) : (
              <View className="flex-row flex-wrap items-center gap-3">
                <Text variant="muted">{t('home.recentError')}</Text>
                <Button
                  title={t('common.retry')}
                  icon="rotate"
                  variant="outline"
                  size="sm"
                  onPress={() => void qc.refetchQueries({ queryKey: qk.recentAll() })}
                />
              </View>
            )}
          </HomeSection>
        ) : null}

        {favouriteBooks.length > 0 ? (
          <HomeSection
            title={t('home.favourites')}
            action={{
              label: t('home.seeAll'),
              onPress: () => router.push('/library/favourites'),
            }}
          >
            <ShelfRow
              data={favouriteBooks}
              keyExtractor={favouriteKey}
              accessibilityLabel={t('home.favourites')}
              renderItem={(f, width) => (
                <CoverTile
                  connectionId={f.connectionId}
                  libraryId={f.library_id}
                  path={f.path}
                  title={bookTitle(f.title, f.path)}
                  author={f.author}
                  caption={f.author}
                  server={serverLabel(f.connectionId)}
                  width={width}
                  onShelf
                />
              )}
            />
          </HomeSection>
        ) : null}

        {finishedItems.length > 0 ? (
          <HomeSection
            title={t('home.recentlyFinished')}
            action={{
              label: t('home.seeAll'),
              onPress: () => router.push('/browse?type=finished'),
            }}
          >
            <ShelfRow
              data={finishedItems}
              keyExtractor={progressKey}
              renderItem={progressTile}
              accessibilityLabel={t('home.recentlyFinished')}
            />
          </HomeSection>
        ) : null}
      </ScrollView>
    </View>
  );
}
