import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { useApi } from '@/api/provider';
import { HistorySection } from '@/components/library/history-section';
import { NotesSection } from '@/components/library/notes-section';
import { SeekBar } from '@/components/player/seek-bar';
import { SleepTimerButton } from '@/components/player/sleep-timer-button';
import { SpeedButton } from '@/components/player/speed-button';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { formatClock } from '@/lib/format';
import { pathLeaf } from '@/lib/paths';
import { useSleepTimer } from '@/playback/sleep-timer';
import { selectBookPosition, selectCurrentChapter, selectIsPlaying, usePlayer } from '@/playback/store';
import { useShakeToCancel } from '@/playback/use-shake-to-cancel';
import { useSettings } from '@/stores/settings';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

/**
 * The full transport for the currently-playing book, driven by the player store.
 * Rendered inside the player modal (phone) and as the right-hand panel on the
 * desktop book screen.
 */
export function PlayerView() {
  const { scheme } = useTheme();
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;
  const api = useApi();
  const [sheet, setSheet] = useState<'history' | 'notes' | null>(null);

  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const bookPosition = usePlayer(selectBookPosition);
  const currentChapter = usePlayer(selectCurrentChapter);
  const isPlaying = usePlayer(selectIsPlaying);
  const trackIndex = usePlayer((s) => s.snapshot.trackIndex);
  const trackPos = usePlayer((s) => s.snapshot.position);
  const trackDur = usePlayer((s) => s.snapshot.duration);
  const rate = usePlayer((s) => s.rate);
  const toggle = usePlayer((s) => s.toggle);
  const seekBook = usePlayer((s) => s.seekBook);
  const seekInTrack = usePlayer((s) => s.seekInTrack);
  const goToTrack = usePlayer((s) => s.goToTrack);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const sleepActive = useSleepTimer((s) => s.active);
  const sleepRemaining = useSleepTimer((s) => s.remaining);
  useShakeToCancel();

  if (!nowPlaying) return <Spinner center />;

  const { queue, title, cover, libraryId, path } = nowPlaying;
  const total = queue.total;
  const rateLabel = `${Number(rate.toFixed(2))}×`;
  // When file durations are unknown (total 0), the whole-book timeline isn't
  // reliable — drive the UI from the engine's current-track position/duration
  // and navigate per-file instead.
  const perTrack = total <= 0;

  const segStart = currentChapter ? currentChapter.book_offset : 0;
  const segLength = perTrack
    ? Math.max(1, trackDur)
    : currentChapter
      ? Math.max(1, currentChapter.end - currentChapter.start)
      : total;
  const segElapsed = perTrack ? trackPos : Math.max(0, Math.min(segLength, bookPosition - segStart));
  const segRemaining = Math.max(0, segLength - segElapsed);
  const bookLeft = Math.max(0, total - bookPosition) / (rate > 0 ? rate : 1);
  const centerLabel = perTrack
    ? `File ${trackIndex + 1} of ${queue.tracks.length}`
    : `${formatClock(bookLeft)} left (${rateLabel})`;
  const onSeek = (p: number) => (perTrack ? void seekInTrack(p) : void seekBook(segStart + p));

  // Title line: the current chapter, else the current file's name.
  const track = queue.tracks[trackIndex];
  const trackName = track ? pathLeaf(track.id.split(':').slice(1).join(':')) || title : title;
  const segTitle = currentChapter ? currentChapter.title || `Chapter ${currentChapter.index + 1}` : trackName;

  // Prev/next: per file when there's no timeline, else by chapter/file boundary.
  const segs = queue.chapters.length > 0 ? queue.chapters.map((c) => c.book_offset) : queue.offsets;
  const curStart = [...segs].reverse().find((s) => s <= bookPosition + 0.01) ?? 0;
  const goNext = () => {
    if (perTrack) return void goToTrack(trackIndex + 1);
    const n = segs.find((s) => s > bookPosition + 1.5);
    if (n !== undefined) void seekBook(n);
  };
  const goPrev = () => {
    if (perTrack) {
      if (trackPos > 3) return void seekInTrack(0);
      return void goToTrack(trackIndex - 1);
    }
    if (bookPosition - curStart > 3) return void seekBook(curStart);
    const prior = segs.filter((s) => s < curStart - 0.01);
    void seekBook(prior.length ? prior[prior.length - 1] : 0);
  };

  return (
    <View className="flex-1">
      {/* Cover fills the space; falls back to the title when there's no art. */}
      <View className="items-center p-6">
        <View className="aspect-square w-full max-w-[300px]">
          <Cover source={cover ? { uri: cover, headers: api.authHeaders() } : null} label={title} />
          {sleepActive && sleepRemaining !== null ? (
            <View className="absolute right-2 top-2 flex-row items-center gap-1 rounded-full bg-black/60 px-2 py-1">
              <Icon name="sleep" size={12} color={colors.white} />
              <Text className="text-xs text-white dark:text-white">{formatClock(sleepRemaining)}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Transport pinned toward the bottom. */}
      <View className="flex-1 justify-between gap-5 px-6 pb-4 bg-gray-200 dark:bg-gray-800 bg-opacity-90 dark:bg-opacity-90">
        <Text variant="subtitle" className="text-center" numberOfLines={1}>
          {segTitle}
        </Text>

        <View className="gap-1">
          <SeekBar position={segElapsed} duration={segLength} onSeek={onSeek} />
          <View className="flex-row items-center justify-between">
            <Text variant="caption">{formatClock(segElapsed)}</Text>
            <Text variant="caption" className="flex-1 text-center">
              {centerLabel}
            </Text>
            <Text variant="caption">-{formatClock(segRemaining)}</Text>
          </View>
        </View>

        <View className="flex-row items-center justify-center gap-6">
          <Pressable onPress={goPrev} hitSlop={8} className="h-10 w-10 items-center justify-center">
            <Icon name="prev" size={24} color={neutral} />
          </Pressable>
          <Pressable onPress={() => void skipSeconds(-skipBackward)} className="items-center justify-center" hitSlop={8}>
            <Icon name="backward" size={50} color={neutral} />
            <View className="absolute inset-0 items-center justify-center">
              <Text variant="caption">{skipBackward}</Text>
            </View>
          </Pressable>
          <Pressable
            onPress={() => void toggle()}
            className="h-20 w-20 items-center justify-center rounded-full bg-primary active:opacity-80"
          >
            <Icon name={isPlaying ? 'pause' : 'play'} size={28} color={colors.white} />
          </Pressable>
          <Pressable onPress={() => void skipSeconds(skipForward)} className="items-center justify-center" hitSlop={8}>
            <Icon name="forward" size={50} color={neutral} />
            <View className="absolute inset-0 items-center justify-center">
              <Text variant="caption">{skipForward}</Text>
            </View>
          </Pressable>
          <Pressable onPress={goNext} hitSlop={8} className="h-10 w-10 items-center justify-center">
            <Icon name="next" size={24} color={neutral} />
          </Pressable>
        </View>

        <View className="flex-row items-center justify-between px-2">
          
            <SpeedButton />
            <Pressable onPress={() => setSheet('history')} hitSlop={8} className="items-center gap-0.5">
              <Icon name="history" size={20} color={neutral} />
            </Pressable>
            <Pressable onPress={() => setSheet('notes')} hitSlop={8} className="items-center gap-0.5">
              <Icon name="notes" size={20} color={neutral} />
            </Pressable>
            <SleepTimerButton />
        </View>
      </View>

      {/* In-view overlay rather than a nested RN <Modal>: a Modal inside the
          native full-screen player modal won't present on iOS. */}
      {sheet !== null ? (
        <View className="absolute inset-0 justify-end">
          <Pressable className="absolute inset-0 bg-black/40" onPress={() => setSheet(null)} />
          <View className="max-h-[75%] rounded-t-2xl bg-gray-100 p-4 dark:bg-gray-840">
            <ScrollView contentContainerClassName="pb-4" keyboardShouldPersistTaps="handled">
              {sheet === 'history' ? <HistorySection libraryId={libraryId} path={path} /> : null}
              {sheet === 'notes' ? <NotesSection libraryId={libraryId} path={path} /> : null}
            </ScrollView>
          </View>
        </View>
      ) : null}
    </View>
  );
}
