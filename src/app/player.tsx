import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useBook, useChapters } from '@/api/hooks';
import { useApi } from '@/api/provider';
import { PlayerView } from '@/components/player/player-view';
import { Spinner } from '@/components/ui/spinner';
import { segmentsToPath } from '@/lib/paths';
import { usePlayer } from '@/playback/store';

export default function PlayerScreen() {
  const {
    libraryId: libParam,
    path: pathParam,
    position,
    track,
  } = useLocalSearchParams<{
    libraryId?: string;
    path?: string | string[];
    position?: string;
    track?: string;
  }>();
  const libraryId = Number(libParam);
  const path = segmentsToPath(pathParam);
  const api = useApi();
  const insets = useSafeAreaInsets();

  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const seekBook = usePlayer((s) => s.seekBook);
  const goToTrack = usePlayer((s) => s.goToTrack);

  const { data: book } = useBook(libraryId, path);
  const chaptersQuery = useChapters(libraryId, path);
  const chapterData = chaptersQuery.data;

  // Start playback once the book AND its chapters/files have loaded — otherwise
  // multi-file/folder books would fall back to streaming the folder path and
  // chapters would be missing. Start point priority: explicit position (bookmark
  // jump) > resume. If this book is already playing, only honor an explicit jump.
  useEffect(() => {
    if (!book || Number.isNaN(libraryId) || chaptersQuery.isLoading) return;
    const posParam = position !== undefined ? Number(position) : undefined;
    const hasPos = posParam !== undefined && !Number.isNaN(posParam);
    const trackParam = track !== undefined ? Number(track) : undefined;
    const hasTrack = trackParam !== undefined && !Number.isNaN(trackParam);
    // Compare against the book's canonical rel_path — playBook stores that as
    // nowPlaying.path, which can differ from the decoded route param. Using the
    // route param here made the guard never match for some paths, re-invoking
    // playBook every render (hammering getProgress + restarting playback).
    if (nowPlaying?.libraryId === libraryId && nowPlaying?.path === book.rel_path) {
      if (hasPos) void seekBook(posParam);
      else if (hasTrack) void goToTrack(trackParam);
      return;
    }
    const startAt = hasPos ? posParam : undefined;
    void usePlayer
      .getState()
      .playBook(api, libraryId, book, chapterData, startAt, hasTrack ? trackParam : undefined);
  }, [
    api,
    book,
    chapterData,
    chaptersQuery.isLoading,
    libraryId,
    path,
    position,
    track,
    nowPlaying,
    seekBook,
    goToTrack,
  ]);

  if (!book && !nowPlaying) {
    return (
      <View
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        className="flex-1 bg-gray-200 dark:bg-gray-800"
      >
        <Spinner center />
      </View>
    );
  }

  return (
    <View
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      className="flex-1 bg-gray-200 dark:bg-gray-800"
    >
      {/* The close button is the only mobile-specific chrome; PlayerView renders
          it in its top toolbar when given onClose. */}
      <PlayerView onClose={() => router.back()} />
    </View>
  );
}
