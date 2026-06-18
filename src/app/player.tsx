import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useBook, useChapters } from '@/api/hooks';
import { useApi } from '@/api/provider';
import { SeekBar } from '@/components/player/seek-bar';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { formatClock } from '@/lib/format';
import { segmentsToPath } from '@/lib/paths';
import {
  selectBookPosition,
  selectCurrentChapter,
  selectIsPlaying,
  usePlayer,
} from '@/playback/store';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

const RATES = [0.8, 1, 1.25, 1.5, 1.75, 2];

export default function PlayerScreen() {
  const { libraryId: libParam, path: pathParam, chapter } = useLocalSearchParams<{
    libraryId?: string;
    path?: string | string[];
    chapter?: string;
  }>();
  const libraryId = Number(libParam);
  const path = segmentsToPath(pathParam);
  const api = useApi();
  const { scheme } = useTheme();
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;

  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const bookPosition = usePlayer(selectBookPosition);
  const currentChapter = usePlayer(selectCurrentChapter);
  const isPlaying = usePlayer(selectIsPlaying);
  const rate = usePlayer((s) => s.rate);
  const toggle = usePlayer((s) => s.toggle);
  const seekBook = usePlayer((s) => s.seekBook);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const setRate = usePlayer((s) => s.setRate);

  const { data: book } = useBook(libraryId, path);
  const chaptersQuery = useChapters(libraryId, path);
  const chapterData = chaptersQuery.data;

  // Start playback once the book AND its chapters/files have loaded — otherwise
  // multi-file/folder books would fall back to streaming the folder path and
  // chapters would be missing. A chapter param starts there; else resume.
  useEffect(() => {
    if (!book || Number.isNaN(libraryId) || chaptersQuery.isLoading) return;
    if (nowPlaying?.libraryId === libraryId && nowPlaying?.path === path) return;
    const idx = chapter !== undefined ? Number(chapter) : NaN;
    const startAt =
      !Number.isNaN(idx) && chapterData?.chapters?.[idx]
        ? chapterData.chapters[idx].book_offset
        : undefined;
    void usePlayer.getState().playBook(api, libraryId, book, chapterData, startAt);
  }, [api, book, chapterData, chaptersQuery.isLoading, libraryId, path, chapter, nowPlaying]);

  const total = nowPlaying?.queue.total ?? book?.duration ?? 0;
  const title = nowPlaying?.title ?? book?.title ?? '';
  const author = nowPlaying?.author ?? book?.author ?? '';
  const coverUrl = nowPlaying?.cover ?? (book ? api.coverUrl(libraryId, path) : undefined);
  const chapterCount = nowPlaying?.queue.chapters.length ?? 0;

  // The seek bar tracks the current chapter (book-wide remaining shown below it).
  const segStart = currentChapter ? currentChapter.book_offset : 0;
  const segLength = currentChapter ? Math.max(1, currentChapter.end - currentChapter.start) : total;
  const segElapsed = Math.max(0, Math.min(segLength, bookPosition - segStart));
  const segRemaining = Math.max(0, segLength - segElapsed);

  if (!book && !nowPlaying) {
    return (
      <SafeAreaView className="flex-1 bg-gray-200 dark:bg-gray-800">
        <Spinner center />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-gray-200 dark:bg-gray-800">
      <View className="flex-row items-center justify-between px-4 py-2">
        <Pressable onPress={() => router.back()} hitSlop={12} className="h-8 w-8 items-center justify-center">
          <Icon name="chevron-down" size={26} color={neutral} />
        </Pressable>
        {chapterCount > 0 && currentChapter ? (
          <Text variant="caption">
            Chapter {currentChapter.index + 1} of {chapterCount}
          </Text>
        ) : null}
        <View className="h-8 w-8" />
      </View>

      {/* Cover + title fill the available space and stay centered. */}
      <View className="flex-1 items-center justify-center gap-6 px-6">
        <View className="aspect-square w-full max-w-[300px]">
          <Cover source={coverUrl ? { uri: coverUrl, headers: api.authHeaders() } : null} label={title} />
        </View>
        <View className="items-center gap-1">
          <Text variant="heading" className="text-center" numberOfLines={2}>
            {title}
          </Text>
          {author ? <Text variant="muted">{author}</Text> : null}
        </View>
      </View>

      {/* Transport pinned toward the bottom. */}
      <View className="gap-5 px-6 pb-4">
        {currentChapter ? (
          <Text variant="subtitle" className="text-center" numberOfLines={1}>
            {currentChapter.title || `Chapter ${currentChapter.index + 1}`}
          </Text>
        ) : null}

        <View className="gap-1">
          <SeekBar position={segElapsed} duration={segLength} onSeek={(p) => void seekBook(segStart + p)} />
          <View className="flex-row justify-between">
            <Text variant="caption">{formatClock(segElapsed)}</Text>
            <Text variant="caption">-{formatClock(segRemaining)}</Text>
          </View>
          {total > segLength + 1 ? (
            <Text variant="caption" className="text-center">
              {formatClock(Math.max(0, total - bookPosition))} left in book
            </Text>
          ) : null}
        </View>

        <View className="flex-row items-center justify-center gap-10">
          <Pressable onPress={() => void skipSeconds(-15)} className="items-center gap-0.5" hitSlop={8}>
            <Icon name="backward" size={30} color={neutral} />
            <Text variant="caption">15</Text>
          </Pressable>
          <Pressable
            onPress={() => void toggle()}
            className="h-16 w-16 items-center justify-center rounded-full bg-primary active:opacity-80"
          >
            <Icon name={isPlaying ? 'pause' : 'play'} size={28} color={colors.white} />
          </Pressable>
          <Pressable onPress={() => void skipSeconds(30)} className="items-center gap-0.5" hitSlop={8}>
            <Icon name="forward" size={30} color={neutral} />
            <Text variant="caption">30</Text>
          </Pressable>
        </View>

        <View className="flex-row flex-wrap items-center justify-center gap-2">
          {RATES.map((r) => {
            const active = rate === r;
            return (
              <Pressable
                key={r}
                onPress={() => void setRate(r)}
                className={`rounded-full px-3 py-1.5 ${active ? 'bg-primary' : 'bg-gray-100 dark:bg-gray-840'}`}
              >
                <Text className={`text-sm ${active ? 'text-white' : 'text-gray-600 dark:text-gray-400'}`}>
                  {r}×
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </SafeAreaView>
  );
}
