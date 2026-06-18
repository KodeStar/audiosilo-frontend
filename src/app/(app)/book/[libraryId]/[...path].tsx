import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import { useBook, useChapters } from '@/api/hooks';
import { useApi } from '@/api/provider';
import { BookmarksSection } from '@/components/library/bookmarks-section';
import { NotesSection } from '@/components/library/notes-section';
import { Button } from '@/components/ui/button';
import { Cover } from '@/components/ui/cover';
import { ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { bookSubtitle, formatClock, formatDuration } from '@/lib/format';
import { segmentsToPath } from '@/lib/paths';

export default function BookDetailScreen() {
  const { libraryId: libraryIdParam, path: pathParam } = useLocalSearchParams<{
    libraryId: string;
    path?: string | string[];
  }>();
  const libraryId = Number(libraryIdParam);
  const path = segmentsToPath(pathParam);
  const api = useApi();

  const { data: book, isLoading, error, refetch } = useBook(libraryId, path);
  const { data: chapterData } = useChapters(libraryId, path);

  const openPlayer = (chapterIndex?: number) =>
    router.push({
      pathname: '/player',
      params: {
        libraryId: String(libraryId),
        path,
        ...(chapterIndex !== undefined ? { chapter: String(chapterIndex) } : {}),
      },
    });

  if (isLoading) return <Spinner center />;
  if (error || !book) {
    return (
      <View className="flex-1 p-4">
        <ErrorNote message="Could not load this book." onRetry={() => refetch()} />
      </View>
    );
  }

  const subtitle = bookSubtitle({
    author: book.author,
    series: book.series,
    seriesIndex: book.series_index,
  });
  const chapters = chapterData?.chapters ?? [];

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-6 p-4">
      <View className="gap-4 md:flex-row md:items-start">
        <View className="w-full max-w-[240px] self-center md:self-start">
          <Cover source={{ uri: api.coverUrl(libraryId, path), headers: api.authHeaders() }} label={book.title} />
        </View>

        <View className="flex-1 gap-2">
          <Text variant="heading">{book.title}</Text>
          {subtitle ? <Text variant="title">{subtitle}</Text> : null}
          {book.narrator ? <Text variant="muted">Narrated by {book.narrator}</Text> : null}
          <Text variant="muted">
            {[formatDuration(book.duration), book.format?.toUpperCase()].filter(Boolean).join(' · ')}
          </Text>
          <View className="mt-2">
            <Button title="Listen" icon="play" onPress={() => openPlayer()} />
          </View>
        </View>
      </View>

      {chapters.length > 0 ? (
        <View className="gap-2">
          <Text variant="title">Chapters</Text>
          {chapters.map((ch) => (
            <Pressable
              key={ch.index}
              onPress={() => openPlayer(ch.index)}
              className="flex-row items-center gap-3 rounded-lg bg-white p-3 active:opacity-80 dark:border dark:border-gray-860 dark:bg-gray-840"
            >
              <Text variant="muted" className="w-7 text-center">
                {ch.index + 1}
              </Text>
              <Text className="flex-1" numberOfLines={1}>
                {ch.title || `Chapter ${ch.index + 1}`}
              </Text>
              <Text variant="caption">{formatClock(Math.max(0, ch.end - ch.start))}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <BookmarksSection libraryId={libraryId} path={path} />
      <NotesSection libraryId={libraryId} path={path} />
    </ScrollView>
  );
}
