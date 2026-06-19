import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';

import { useBook, useChapters, useLibraries } from '@/api/hooks';
import { useApi } from '@/api/provider';
import type { Chapter } from '@/api/types';
import { ContentColumn } from '@/components/layout/content-column';
import { BookmarksSection } from '@/components/library/bookmarks-section';
import { DownloadControl } from '@/components/library/download-control';
import { HistorySection } from '@/components/library/history-section';
import { NotesSection } from '@/components/library/notes-section';
import { PlayerView } from '@/components/player/player-view';
import { BreadCrumbs, type Crumb } from '@/components/ui/breadcrumbs';
import { Button } from '@/components/ui/button';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useDownloadEntry } from '@/downloads/store';
import { bookSubtitle, formatBitrate, formatDuration, formatDurationFull } from '@/lib/format';
import { libraryHref, pathLeaf, segmentsToPath } from '@/lib/paths';
import { selectCurrentChapter, usePlayer } from '@/playback/store';
import { colors } from '@/theme/tokens';

const WIDE_BREAKPOINT = 1024;

export default function BookDetailScreen() {
  const { libraryId: libraryIdParam, path: pathParam } = useLocalSearchParams<{
    libraryId: string;
    path?: string | string[];
  }>();
  const libraryId = Number(libraryIdParam);
  const path = segmentsToPath(pathParam);
  const api = useApi();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;

  const { data: book, isLoading, error, refetch } = useBook(libraryId, path);
  const { data: chapterData, isLoading: chaptersLoading } = useChapters(libraryId, path);
  const { data: libraries } = useLibraries();

  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const currentChapter = usePlayer(selectCurrentChapter);
  const downloadEntry = useDownloadEntry(libraryId, path);

  if (isLoading) return <Spinner center />;
  // Render whenever we have book data — including a downloaded book served from
  // the seeded query cache while offline. Only error when there is no data.
  if (!book) {
    return (
      <View className="flex-1 p-4">
        <ErrorNote message="Could not load this book." onRetry={() => refetch()} />
      </View>
    );
  }

  const subtitle = bookSubtitle({ author: book.author, series: book.series, seriesIndex: book.series_index });
  const coverUrl = api.coverUrl(libraryId, path);
  const chapters = chapterData?.chapters ?? [];
  const files = chapterData?.files ?? [];
  const listLabel = chapters.length > 0 ? 'Chapters' : 'Files';
  const isThisPlaying = nowPlaying?.libraryId === libraryId && nowPlaying?.path === book.rel_path;
  const activeIndex = isThisPlaying ? currentChapter?.index : undefined;
  const downloaded = downloadEntry?.status === 'downloaded';

  const libraryName = libraries?.find((l) => l.id === libraryId)?.name ?? 'Library';
  const segments = path.split('/').filter(Boolean);
  const crumbs: Crumb[] = [
    { label: libraryName, onPress: () => router.push(libraryHref(libraryId)) },
    ...segments.slice(0, -1).map((seg, i) => ({
      label: seg,
      onPress: () => router.push(libraryHref(libraryId, segments.slice(0, i + 1).join('/'))),
    })),
    { label: book.title, active: true },
  ];

  // Whole-book offset for a file/chapter (the server's book_offset is unreliable;
  // recompute from the cumulative file durations like book-queue does).
  const fileStartOffset = (fileIndex: number) =>
    files.slice(0, fileIndex).reduce((acc, f) => acc + (f.duration > 0 ? f.duration : 0), 0);
  const chapterStart = (ch: Chapter) => (files.length > 0 ? fileStartOffset(ch.file_index) + ch.start : ch.book_offset);

  // On desktop the player lives in the right panel, so play inline; on phone open
  // the full-screen player modal. A chapter is addressed by whole-book position;
  // a file by track index (durations may be unknown, so a position can't locate it).
  const goPlay = (target: { position?: number; track?: number }) => {
    if (wide) {
      void usePlayer.getState().playBook(api, libraryId, book, chapterData, target.position, target.track);
    } else {
      router.push({
        pathname: '/player',
        params: {
          libraryId: String(libraryId),
          path,
          ...(target.position !== undefined ? { position: String(Math.round(target.position)) } : {}),
          ...(target.track !== undefined ? { track: String(target.track) } : {}),
        },
      });
    }
  };

  // A list row (chapter or file): a full-height blue block + book icon, the
  // duration/bitrate line, and a cached dot. The currently-playing row stays
  // bright while the others dim — matching the old client (no pink highlight).
  const fileRow = (
    key: string | number,
    name: string,
    durationSec: number,
    bitrate: string,
    onPress: () => void,
    dim: boolean,
  ) => (
    <Pressable
      key={key}
      onPress={onPress}
      className={`my-1 w-full flex-row items-center overflow-hidden rounded-lg bg-gray-50 shadow-sm active:opacity-80 dark:border dark:border-gray-900 dark:bg-gray-840 dark:shadow-none ${
        dim ? 'opacity-50' : ''
      }`}
    >
      <View className="min-h-[3.5rem] items-center justify-center self-stretch bg-blue-500 px-4">
        <Icon name="book" size={20} color={colors.white} />
      </View>
      <View className="flex-1 flex-row items-center justify-between">
        <View className="flex-1 px-5 py-2">
          <Text variant="subtitle" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="caption">
            {`Duration: ${formatDurationFull(durationSec)}${bitrate ? `   Bitrate: ${bitrate}` : ''}`}
          </Text>
        </View>
        <View className="px-4">
          <View className={`h-3.5 w-3.5 rounded-full ${downloaded ? 'bg-green-400' : 'bg-gray-200 dark:bg-gray-800'}`} />
        </View>
      </View>
    </Pressable>
  );

  const renderRows = () => {
    if (chapters.length > 0) {
      return chapters.map((ch) => {
        const file = files[ch.file_index];
        const dim = isThisPlaying && activeIndex !== undefined && ch.index !== activeIndex;
        return fileRow(
          ch.index,
          ch.title || `Chapter ${ch.index + 1}`,
          Math.max(0, ch.end - ch.start),
          formatBitrate(file?.size, file?.duration),
          () => goPlay({ position: chapterStart(ch) }),
          dim,
        );
      });
    }
    return files.map((f, i) =>
      fileRow(f.rel_path, pathLeaf(f.rel_path), f.duration, formatBitrate(f.size, f.duration), () => goPlay({ track: i }), false),
    );
  };

  const hasList = chapters.length > 0 || files.length > 0;
  const fileList = hasList ? (
    <View>
      <Text className="mb-2 text-xl font-roboto-bold text-gray-700 dark:text-gray-100">{listLabel}</Text>
      {renderRows()}
    </View>
  ) : null;

  if (wide) {
    return (
      <View className="flex-1 flex-row">
        <ContentColumn>
          <ScrollView className="flex-1" contentContainerClassName="gap-4 p-8 pt-2">
            <BreadCrumbs crumbs={crumbs} />
            <DownloadControl libraryId={libraryId} path={path} book={book} chapterData={chapterData} disabled={chaptersLoading} />
            {fileList}
            <BookmarksSection libraryId={libraryId} path={path} />
            <HistorySection libraryId={libraryId} path={path} />
            <NotesSection libraryId={libraryId} path={path} />
          </ScrollView>
        </ContentColumn>

        <View className="w-[380px] border-l border-gray-100 dark:border-gray-750">
          {isThisPlaying ? (
            <PlayerView />
          ) : (
            <View className="flex-1 items-center justify-center gap-6 p-6">
              <View className="aspect-square w-full max-w-[300px]">
                <Cover source={{ uri: coverUrl, headers: api.authHeaders() }} label={book.title} />
              </View>
              <View className="items-center gap-1">
                <Text variant="title" className="text-center" numberOfLines={2}>
                  {book.title}
                </Text>
                {subtitle ? <Text variant="muted">{subtitle}</Text> : null}
                {book.narrator ? <Text variant="muted">Narrated by {book.narrator}</Text> : null}
              </View>
              <Button title="Listen" icon="play" onPress={() => goPlay({})} />
            </View>
          )}
        </View>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-6 p-4 px-8">
      <BreadCrumbs crumbs={crumbs} />

      <View className="gap-4">
        <View className="w-full max-w-[240px] self-center">
          <Cover source={{ uri: coverUrl, headers: api.authHeaders() }} label={book.title} />
        </View>
        <View className="gap-2">
          <Text variant="heading">{book.title}</Text>
          {subtitle ? <Text variant="title">{subtitle}</Text> : null}
          {book.narrator ? <Text variant="muted">Narrated by {book.narrator}</Text> : null}
          <Text variant="muted">
            {[formatDuration(book.duration), book.format?.toUpperCase()].filter(Boolean).join(' · ')}
          </Text>
          <View className="mt-2 gap-2">
            <Button title="Listen" icon="play" onPress={() => goPlay({})} />
            <DownloadControl libraryId={libraryId} path={path} book={book} chapterData={chapterData} disabled={chaptersLoading} />
          </View>
        </View>
      </View>

      {fileList}

      <BookmarksSection libraryId={libraryId} path={path} />
      <HistorySection libraryId={libraryId} path={path} />
      <NotesSection libraryId={libraryId} path={path} />
    </ScrollView>
  );
}
