import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAddBookmark, useBook, useChapters } from '@/api/hooks';
import { useApi } from '@/api/provider';
import { PlayerView } from '@/components/player/player-view';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { segmentsToPath } from '@/lib/paths';
import { selectBookPosition, usePlayer } from '@/playback/store';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

export default function PlayerScreen() {
  const { libraryId: libParam, path: pathParam, chapter, position, track } = useLocalSearchParams<{
    libraryId?: string;
    path?: string | string[];
    chapter?: string;
    position?: string;
    track?: string;
  }>();
  const libraryId = Number(libParam);
  const path = segmentsToPath(pathParam);
  const api = useApi();
  const { scheme } = useTheme();
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;

  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const bookPosition = usePlayer(selectBookPosition);
  const seekBook = usePlayer((s) => s.seekBook);
  const goToTrack = usePlayer((s) => s.goToTrack);

  const { data: book } = useBook(libraryId, path);
  const chaptersQuery = useChapters(libraryId, path);
  const chapterData = chaptersQuery.data;
  const addBookmark = useAddBookmark(libraryId, path);

  // Start playback once the book AND its chapters/files have loaded — otherwise
  // multi-file/folder books would fall back to streaming the folder path and
  // chapters would be missing. Start point priority: explicit position (bookmark
  // jump) > chapter param > resume. If this book is already playing, only honor
  // an explicit jump.
  useEffect(() => {
    if (!book || Number.isNaN(libraryId) || chaptersQuery.isLoading) return;
    const posParam = position !== undefined ? Number(position) : undefined;
    const hasPos = posParam !== undefined && !Number.isNaN(posParam);
    const trackParam = track !== undefined ? Number(track) : undefined;
    const hasTrack = trackParam !== undefined && !Number.isNaN(trackParam);
    if (nowPlaying?.libraryId === libraryId && nowPlaying?.path === path) {
      if (hasPos) void seekBook(posParam);
      else if (hasTrack) void goToTrack(trackParam);
      return;
    }
    const idx = chapter !== undefined ? Number(chapter) : NaN;
    const startAt = hasPos
      ? posParam
      : !Number.isNaN(idx) && chapterData?.chapters?.[idx]
        ? chapterData.chapters[idx].book_offset
        : undefined;
    void usePlayer.getState().playBook(api, libraryId, book, chapterData, startAt, hasTrack ? trackParam : undefined);
  }, [api, book, chapterData, chaptersQuery.isLoading, libraryId, path, chapter, position, track, nowPlaying, seekBook, goToTrack]);

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
        <Pressable
          onPress={() => addBookmark.mutate({ position: Math.round(bookPosition) })}
          disabled={addBookmark.isPending || !nowPlaying}
          hitSlop={12}
          className="h-8 w-8 items-center justify-center"
        >
          <Icon name="bookmark" size={20} color={neutral} />
        </Pressable>
      </View>

      <PlayerView />
    </SafeAreaView>
  );
}
