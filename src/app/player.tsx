import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
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
  const { data: chapterData } = useChapters(libraryId, path);

  // Start playback when a new book is opened from the library.
  useEffect(() => {
    if (!book || !path || Number.isNaN(libraryId)) return;
    if (nowPlaying?.libraryId === libraryId && nowPlaying?.path === path) return;
    const idx = chapter !== undefined ? Number(chapter) : NaN;
    const startAt =
      !Number.isNaN(idx) && chapterData?.chapters?.[idx] ? chapterData.chapters[idx].book_offset : 0;
    void usePlayer.getState().playBook(api, libraryId, book, chapterData, startAt);
  }, [api, book, chapterData, libraryId, path, chapter, nowPlaying]);

  const total = nowPlaying?.queue.total ?? book?.duration ?? 0;
  const title = nowPlaying?.title ?? book?.title ?? '';
  const author = nowPlaying?.author ?? book?.author ?? '';
  const coverUrl = nowPlaying?.cover ?? (book ? api.coverUrl(libraryId, path) : undefined);

  if (!book && !nowPlaying) {
    return (
      <SafeAreaView className="flex-1 bg-gray-200 dark:bg-gray-800">
        <Spinner center />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-gray-200 dark:bg-gray-800">
      <View className="flex-row justify-end p-3">
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-down" size={26} color={neutral} />
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="items-center gap-7 px-6 pb-10">
        <View className="w-full max-w-[320px]">
          <Cover
            source={coverUrl ? { uri: coverUrl, headers: api.authHeaders() } : null}
            label={title}
          />
        </View>

        <View className="items-center gap-1">
          <Text variant="heading" className="text-center">
            {title}
          </Text>
          {author ? <Text variant="muted">{author}</Text> : null}
          {currentChapter ? (
            <Text variant="caption" className="mt-1 text-center">
              {currentChapter.title}
            </Text>
          ) : null}
        </View>

        <View className="w-full max-w-[480px] gap-1">
          <SeekBar position={bookPosition} duration={total} onSeek={(p) => void seekBook(p)} />
          <View className="flex-row justify-between">
            <Text variant="caption">{formatClock(bookPosition)}</Text>
            <Text variant="caption">-{formatClock(Math.max(0, total - bookPosition))}</Text>
          </View>
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
                <Text
                  className={`text-sm ${active ? 'text-white' : 'text-gray-600 dark:text-gray-400'}`}
                >
                  {r}×
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
