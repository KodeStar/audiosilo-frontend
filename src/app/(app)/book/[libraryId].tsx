import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, useWindowDimensions, View } from 'react-native';

import { useBook, useChapters, useLibraries, useServerInfo } from '@/api/hooks';
import { useApi, useScopedCid } from '@/api/provider';
import type { Chapter } from '@/api/types';
import { ContentColumn } from '@/components/layout/content-column';
import { ContentScope } from '@/components/layout/content-scope';
import { BookMetaSection } from '@/components/library/book-meta';
import { BookmarksSection } from '@/components/library/bookmarks-section';
import { BookStats } from '@/components/library/book-stats';
import { BookVersions } from '@/components/library/book-versions';
import { DownloadControl, DownloadProgress } from '@/components/library/download-control';
import { HistorySection } from '@/components/library/history-section';
import { NotesSection } from '@/components/library/notes-section';
import { CoverBackdrop } from '@/components/player/cover-backdrop';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { PlayerView } from '@/components/player/player-view';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { BreadCrumbs, type Crumb } from '@/components/ui/breadcrumbs';
import { Button } from '@/components/ui/button';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { ErrorNote } from '@/components/ui/query-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useDownloadEntry } from '@/downloads/store';
import { formatBitrate, formatDurationFull } from '@/lib/format';
import { WIDE_BREAKPOINT } from '@/lib/layout';
import { libraryHref, pathLeaf, segmentsToPath } from '@/lib/paths';
import { chapterBookOffset } from '@/playback/book-queue';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import { selectCurrentChapter, usePlayer } from '@/playback/store';
import { colors, tabularNums } from '@/theme/tokens';

// The cover art rounded corner + hairline border + soft shadow, applied wherever
// the hero cover appears so dark covers separate from dark surfaces.
const COVER_FRAME = 'overflow-hidden rounded-lg border border-black/10 dark:border-white/10';

/** Loading placeholder shaped like the final layout: a cover block, title lines,
 * a stat strip and a few chapter rows - no centered spinner. */
function BookSkeleton({ paddingBottom }: { paddingBottom: number }) {
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-6 p-4"
      contentContainerStyle={{ paddingBottom }}
    >
      <View className="items-center gap-4">
        <Skeleton className="aspect-square w-full max-w-[240px] rounded-lg" />
        <View className="w-full items-center gap-2">
          <Skeleton className="h-4 w-1/2 rounded" />
          <Skeleton className="h-6 w-3/4 rounded" />
        </View>
      </View>
      <Skeleton className="h-20 w-full rounded-xl" />
      <Skeleton className="h-12 w-full rounded-lg" />
      <View className="gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </View>
    </ScrollView>
  );
}

// Scope to the route's OWN `?connection=` (read from the local param, reliable on a cold
// deep link) so the body + its sections resolve to that server. The body consumes the
// scope via `useScopedCid()`, so it lives in a child component of `<ContentScope>`.
export default function BookDetailScreen() {
  return (
    <ContentScope>
      <BookDetailContent />
    </ContentScope>
  );
}

function BookDetailContent() {
  const { t } = useTranslation();
  const { libraryId: libraryIdParam, path: pathParam } = useLocalSearchParams<{
    libraryId: string;
    path?: string | string[];
  }>();
  const libraryId = Number(libraryIdParam);
  const path = segmentsToPath(pathParam);
  const api = useApi();
  // The connection rides in the `?connection=` query param; the `(app)` layout publishes
  // it as the scope, so this screen's content resolves to that server (not the default).
  const cid = useScopedCid();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;

  const { data: book, isLoading, refetch } = useBook(libraryId, path);
  const { data: chapterData, isLoading: chaptersLoading } = useChapters(libraryId, path);
  const { data: libraries } = useLibraries();
  // Enriched community metadata is progressive enhancement, gated on the server
  // advertising the capability (older servers omit the flag → false → no query).
  const { data: server } = useServerInfo();
  const metadataEnabled = !!server?.capabilities.metadata;

  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const currentChapter = usePlayer(selectCurrentChapter);
  const downloadEntry = useDownloadEntry(cid, libraryId, path);
  const paddingBottom = useMiniPlayerInset();

  if (isLoading) return <BookSkeleton paddingBottom={paddingBottom} />;
  // Render whenever we have book data - including a downloaded book served from
  // the seeded query cache while offline. Only error when there is no data.
  if (!book) {
    return (
      <View className="flex-1 p-4">
        <ErrorNote message={t('book.loadError')} onRetry={() => refetch()} />
      </View>
    );
  }

  const seriesLabel = book.series
    ? book.series_index
      ? `${book.series} #${book.series_index}`
      : book.series
    : '';
  const coverUrl = api.coverUrl(libraryId, path);
  const coverHeaders = api.authHeaders();
  const coverSource = { uri: coverUrl, headers: coverHeaders };
  const chapters = chapterData?.chapters ?? [];
  const files = chapterData?.files ?? [];
  const listLabel = chapters.length > 0 ? t('book.chaptersTitle') : t('book.filesTitle');
  const isThisPlaying =
    nowPlaying?.connectionId === cid &&
    nowPlaying?.libraryId === libraryId &&
    nowPlaying?.path === book.rel_path;
  const activeIndex = isThisPlaying ? currentChapter?.index : undefined;
  const downloaded = downloadEntry?.status === 'downloaded';

  const libraryName = libraries?.find((l) => l.id === libraryId)?.name ?? t('book.libraryFallback');
  const segments = path.split('/').filter(Boolean);
  const crumbs: Crumb[] = [
    { label: libraryName, onPress: () => router.push(libraryHref(cid, libraryId)) },
    ...segments.slice(0, -1).map((seg, i) => ({
      label: seg,
      onPress: () => router.push(libraryHref(cid, libraryId, segments.slice(0, i + 1).join('/'))),
    })),
    // The active crumb is the on-disk folder/file name (matching the other path
    // crumbs and the browse view); the book's title is shown in the header below.
    { label: pathLeaf(path) || book.title, active: true },
  ];

  // Whole-book offset for a chapter (the server's book_offset is unreliable;
  // recompute from the cumulative file durations - shared with book-queue).
  const fileDurations = files.map((f) => ({ path: f.rel_path, duration: f.duration }));
  const chapterStart = (ch: Chapter) =>
    files.length > 0 ? chapterBookOffset(fileDurations, ch) : ch.book_offset;
  // Chapters carrying the corrected whole-book offset, so the history panel can
  // label each listening span with its chapter.
  const historyChapters = chapters.map((ch) => ({ ...ch, book_offset: chapterStart(ch) }));

  // On desktop the player lives in the right panel, so play inline; on phone open
  // the full-screen player modal. A chapter is addressed by whole-book position;
  // a file by track index (durations may be unknown, so a position can't locate it).
  const goPlay = (target: { position?: number; track?: number }) => {
    if (wide) {
      void usePlayer
        .getState()
        .playBook(cid, libraryId, book, chapterData, target.position, target.track);
    } else {
      router.push({
        pathname: '/player',
        params: {
          connection: cid,
          libraryId: String(libraryId),
          path,
          ...(target.position !== undefined
            ? { position: String(Math.round(target.position)) }
            : {}),
          ...(target.track !== undefined ? { track: String(target.track) } : {}),
        },
      });
    }
  };

  // A quiet chapter/file row: a numbered tile (or a play glyph on a pink tile when
  // this row is the one currently playing), the title, a tabular duration/bitrate
  // line, and a small success check when the book is downloaded. The blue block is
  // gone; the currently-playing row lifts to a soft primary tint.
  const fileRow = (
    key: string | number,
    name: string,
    durationSec: number,
    bitrate: string,
    onPress: () => void,
    index: number,
    active: boolean,
  ) => (
    <AnimatedPressable
      key={key}
      onPress={onPress}
      accessibilityRole="button"
      className={`my-1 w-full flex-row items-center gap-3 rounded-xl px-3 py-2.5 ${
        active
          ? 'bg-primary/10 dark:bg-primary/15'
          : 'bg-white shadow-sm dark:border dark:border-gray-750 dark:bg-gray-840 dark:shadow-none'
      }`}
    >
      <View
        className={`h-9 w-9 items-center justify-center rounded-lg ${active ? 'bg-primary' : 'bg-gray-100 dark:bg-gray-800'}`}
      >
        {active ? (
          <Icon name="play" size={13} color={colors.white} />
        ) : (
          <Text
            className="text-sm font-roboto-semibold text-gray-500 dark:text-gray-400"
            style={tabularNums}
          >
            {index}
          </Text>
        )}
      </View>
      <View className="flex-1">
        <Text
          variant="subtitle"
          numberOfLines={1}
          className={active ? 'text-primary dark:text-primary-400' : ''}
        >
          {prettifyChapterTitle(name)}
        </Text>
        <Text variant="caption" style={tabularNums}>
          {`${t('book.duration', { value: formatDurationFull(durationSec) })}${
            bitrate ? `   ${t('book.bitrate', { value: bitrate })}` : ''
          }`}
        </Text>
      </View>
      {downloaded ? (
        <View className="h-5 w-5 items-center justify-center rounded-full bg-success/15">
          <Icon name="check" size={11} color={colors.success} />
        </View>
      ) : null}
    </AnimatedPressable>
  );

  const renderRows = () => {
    if (chapters.length > 0) {
      return chapters.map((ch, i) => {
        // Highlight only the active chapter among several. With one row there's
        // nothing to distinguish, and the player may report a *synthetic* chapter
        // index (virtual chapters overlaid on an otherwise-chapterless single file)
        // that maps to no real row - so never highlight the lone row.
        const active =
          chapters.length > 1 &&
          isThisPlaying &&
          activeIndex !== undefined &&
          ch.index === activeIndex;
        const file = files[ch.file_index];
        return fileRow(
          ch.index,
          ch.title || t('book.chapterFallback', { number: ch.index + 1 }),
          Math.max(0, ch.end - ch.start),
          formatBitrate(file?.size, file?.duration),
          () => goPlay({ position: chapterStart(ch) }),
          i + 1,
          active,
        );
      });
    }
    return files.map((f, i) =>
      fileRow(
        f.rel_path,
        pathLeaf(f.rel_path),
        f.duration,
        formatBitrate(f.size, f.duration),
        () => goPlay({ track: i }),
        i + 1,
        false,
      ),
    );
  };

  const hasList = chapters.length > 0 || files.length > 0;
  const fileList = hasList ? (
    <View>
      <Text variant="heading" className="mb-2">
        {listLabel}
      </Text>
      {renderRows()}
    </View>
  ) : null;

  if (wide) {
    return (
      <View className="flex-1 flex-row">
        <ContentColumn>
          <ScrollView className="flex-1" contentContainerClassName="gap-4 p-8 pt-2">
            <BreadCrumbs crumbs={crumbs} />
            <BookVersions book={book} connectionId={cid} />
            <DownloadControl
              libraryId={libraryId}
              path={path}
              book={book}
              chapterData={chapterData}
              disabled={chaptersLoading}
            />
            {fileList}
            {metadataEnabled ? <BookMetaSection libraryId={libraryId} path={path} /> : null}
            <BookmarksSection libraryId={libraryId} path={path} />
            <HistorySection libraryId={libraryId} path={path} chapters={historyChapters} />
            <NotesSection libraryId={libraryId} path={path} />
          </ScrollView>
        </ContentColumn>

        <View className="w-[380px] overflow-hidden border-l border-gray-100 dark:border-gray-750">
          {isThisPlaying ? (
            <PlayerView />
          ) : (
            <View className="flex-1 items-center justify-center">
              <CoverBackdrop source={coverSource} />
              <View className="w-full items-center gap-6 p-6">
                <View className={`aspect-square w-full max-w-[300px] shadow-lg ${COVER_FRAME}`}>
                  <Cover source={coverSource} label={book.title} sublabel={book.author} />
                </View>
                <View className="items-center gap-1">
                  {book.author ? (
                    <Text variant="muted" className="text-center opacity-80">
                      {t('book.byAuthor', { author: book.author })}
                    </Text>
                  ) : null}
                  <Text variant="title" className="text-center" numberOfLines={2}>
                    {book.title}
                  </Text>
                  {seriesLabel ? (
                    <Text variant="muted" className="text-center">
                      {seriesLabel}
                    </Text>
                  ) : null}
                </View>
                <BookStats libraryId={libraryId} path={path} book={book} />
                <Button
                  title={t('book.listen')}
                  icon="play"
                  className="w-full"
                  onPress={() => goPlay({})}
                />
                {book.narrator ? (
                  <Text variant="muted" className="text-center">
                    {t('book.narratedBy', { narrator: book.narrator })}
                  </Text>
                ) : null}
              </View>
            </View>
          )}
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-6 p-4"
      contentContainerStyle={{ paddingBottom }}
    >
      <BreadCrumbs crumbs={crumbs} />

      <BookVersions book={book} connectionId={cid} />

      <View className="overflow-hidden rounded-2xl">
        <CoverBackdrop source={coverSource} />
        <View className="items-center gap-4 p-5">
          <View className={`w-full max-w-[240px] shadow-lg ${COVER_FRAME}`}>
            <Cover source={coverSource} label={book.title} sublabel={book.author} />
          </View>
          <View className="w-full gap-1">
            {book.author ? (
              <Text variant="body" className="text-center opacity-80">
                {t('book.byAuthor', { author: book.author })}
              </Text>
            ) : null}
            <Text variant="heading" className="text-center">
              {book.title}
            </Text>
            {seriesLabel ? (
              <Text variant="muted" className="text-center">
                {seriesLabel}
              </Text>
            ) : null}
          </View>
          <BookStats libraryId={libraryId} path={path} book={book} />
        </View>
      </View>

      <View className="gap-3">
        <View className="flex-row gap-2">
          <Button
            title={t('book.listen')}
            icon="play"
            className="flex-1"
            onPress={() => goPlay({})}
          />
          <DownloadControl
            libraryId={libraryId}
            path={path}
            book={book}
            chapterData={chapterData}
            disabled={chaptersLoading}
            compact
          />
        </View>

        <DownloadProgress libraryId={libraryId} path={path} />

        {book.narrator ? (
          <Text variant="muted" className="text-center">
            {t('book.narratedBy', { narrator: book.narrator })}
          </Text>
        ) : null}
      </View>

      {fileList}

      {metadataEnabled ? <BookMetaSection libraryId={libraryId} path={path} /> : null}
      <BookmarksSection libraryId={libraryId} path={path} />
      <HistorySection libraryId={libraryId} path={path} chapters={historyChapters} />
      <NotesSection libraryId={libraryId} path={path} />
    </ScrollView>
  );
}
