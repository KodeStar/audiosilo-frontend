import { useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

import { useAddBookmark } from '@/api/hooks';
import { useApi } from '@/api/provider';
import { BookmarksSection } from '@/components/library/bookmarks-section';
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
import {
  selectBookPosition,
  selectCurrentChapter,
  selectIsPlaying,
  usePlayer,
} from '@/playback/store';
import { useShakeToCancel } from '@/playback/use-shake-to-cancel';
import { useSettings } from '@/stores/settings';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

/**
 * The full transport for the currently-playing book, driven by the player store.
 * Rendered inside the player modal (phone) and as the right-hand panel on the
 * desktop book screen — identical everywhere except the close button, which the
 * phone modal supplies via `onClose` (the desktop panel has nothing to close).
 *
 * The top toolbar's right side is the home for player actions (bookmark,
 * history, notes, speed, sleep) and where new ones should be added.
 */
export function PlayerView({ onClose }: { onClose?: () => void }) {
  const { scheme } = useTheme();
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;
  const api = useApi();
  const [sheet, setSheet] = useState<'history' | 'notes' | 'bookmarks' | null>(null);
  // Brief "saved" confirmation after adding a bookmark; the ref lets a rapid
  // second add reset the timer instead of stacking timeouts.
  const [savedBookmark, setSavedBookmark] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  // Keyed to the playing book; placeholders keep hook order stable before the
  // early return below (nowPlaying is null only briefly while loading).
  const addBookmark = useAddBookmark(nowPlaying?.libraryId ?? -1, nowPlaying?.path ?? '');

  const onAddBookmark = () =>
    addBookmark.mutate(
      { position: Math.round(bookPosition) },
      {
        onSuccess: () => {
          setSavedBookmark(true);
          if (savedTimer.current) clearTimeout(savedTimer.current);
          savedTimer.current = setTimeout(() => setSavedBookmark(false), 1800);
        },
      },
    );

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
  const segElapsed = perTrack
    ? trackPos
    : Math.max(0, Math.min(segLength, bookPosition - segStart));
  const segRemaining = Math.max(0, segLength - segElapsed);
  const bookLeft = Math.max(0, total - bookPosition) / (rate > 0 ? rate : 1);
  const centerLabel = perTrack
    ? `File ${trackIndex + 1} of ${queue.tracks.length}`
    : `${formatClock(bookLeft)} left (${rateLabel})`;
  const onSeek = (p: number) => (perTrack ? void seekInTrack(p) : void seekBook(segStart + p));

  // Title line: the current chapter, else the current file's name.
  const track = queue.tracks[trackIndex];
  const trackName = track ? pathLeaf(track.id.split(':').slice(1).join(':')) || title : title;
  const segTitle = currentChapter
    ? currentChapter.title || `Chapter ${currentChapter.index + 1}`
    : trackName;

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
      {/* Header (auto height). The close button is mobile-only (the phone modal
          passes onClose; the desktop panel has nothing to close). The right side
          is the shared action area where new player functionality is added. */}
      <View className="flex-row items-center px-4 py-2">
        {onClose ? (
          <Pressable onPress={onClose} hitSlop={12} className="h-8 w-8 items-center justify-center">
            <Icon name="chevron-down" size={26} color={neutral} />
          </Pressable>
        ) : null}
        <View className="ml-auto flex-row items-center gap-4">
          <Pressable
            onPress={() => setSheet('bookmarks')}
            hitSlop={8}
            className="h-8 w-8 items-center justify-center"
          >
            <Icon name="bookmark" size={20} color={neutral} />
          </Pressable>
        </View>
      </View>

      {/* Middle (flex-1, centered): fills the space between header and footer and
          centers the cover + transport as a group. flex-1 here stretches the
          *container*, not the content — justify-center keeps the cover/title/
          controls tightly grouped and absorbs the leftover space symmetrically,
          so the layout looks the same regardless of viewport height (web window
          vs tall phone). The inner transport stays content-sized — a flex-1
          child here would collapse on iOS (Yoga). */}
      <View className="flex-1 justify-center items-center p-8 ">
        {/* Cover fills the space; falls back to the title when there's no art.
            One unified card: cover flush at the rounded top, transport in the
            padded body. Shadow in light mode; in dark mode (where a shadow is
            invisible) a subtle border gives the edge — the codebase convention
            (see ui/card.tsx).

            Background: native (iOS/Android) derives a view's drop shadow from the
            alpha mask of its *content*, not its border box — so a translucent
            bg (black/5) makes shadow-lg hug only the opaque cover, not the whole
            card. Use an opaque surface on native (matching the black/5 ~ white/5
            tint over the gray-200/gray-800 page) so the shadow wraps the full
            rounded box. Web's box-shadow already follows the border box, so keep
            the translucent tint there. */}
        <View
          className={`w-full max-w-[380px] items-center rounded-[2rem] shadow-lg dark:shadow-lg dark:border dark:border-white/10 ${
            Platform.OS === 'web' ? 'bg-black/5 dark:bg-white/5' : 'bg-gray-300 dark:bg-gray-750'
          }`}
        >
          <View className="items-center w-full">
            <View className="aspect-square w-full ">
              <Cover
                source={cover ? { uri: cover, headers: api.authHeaders() } : null}
                label={title}
                rounded="rounded-t-[2rem]"
              />
              {sleepActive && sleepRemaining !== null ? (
                <View className="absolute right-2 top-2 flex-row items-center gap-1 rounded-full bg-black/60 px-2 py-1">
                  <Icon name="sleep" size={12} color={colors.white} />
                  <Text className="text-xs text-white dark:text-white">
                    {formatClock(sleepRemaining)}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>

          {/* Transport: fills the card body (w-full) so the seek bar and controls
            span the same width on web and native — without it the row shrink-wraps
            and renders as a narrow column inset in the card on mobile. */}
          <View className="w-full p-4">
            <View className="w-full flex flex-row items-center justify-between">
              <Pressable
                onPress={goPrev}
                hitSlop={8}
                className="h-10 w-10 items-center justify-center"
              >
                <Icon name="prev" size={24} color={neutral} />
              </Pressable>

              <Text variant="subtitle" className="text-center" numberOfLines={1}>
                {segTitle}
              </Text>
              <Pressable
                onPress={goNext}
                hitSlop={8}
                className="h-10 w-10 items-center justify-center"
              >
                <Icon name="next" size={24} color={neutral} />
              </Pressable>
            </View>

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

            <View className="flex-row items-center justify-center gap-6 py-8">
              <Pressable
                onPress={() => void skipSeconds(-skipBackward)}
                className="items-center justify-center"
                hitSlop={8}
              >
                <View className="w-[48px] h-[48px] rounded-full items-center relative justify-center bg-gray-400/30 overflow-hidden border-4 border-l-0 border-b-2 border-l-transparent border-gray-400/15">
                  <Icon
                    className="-rotate-[141deg] absolute -top-0.5 -left-1"
                    name="triangle"
                    size={20}
                    color={'#9ca3af4d'}
                  />
                  <View className="absolute inset-0 items-center justify-center">
                    <Text variant="subtitle">-{skipBackward}s</Text>
                  </View>
                </View>
              </Pressable>
              <Pressable
                onPress={() => void toggle()}
                className="h-[112px] w-[112px] items-center justify-center rounded-full bg-primary active:opacity-80"
              >
                {/* Diagonal bevel highlight. Drawn as an SVG ring with a 135°
                    white→transparent→white gradient stroke rather than per-side
                    borders + rotation: iOS clips a non-uniform border on a fully
                    rounded view (curved corners square off), so the bevel
                    rendered cropped there while web was fine. An SVG stroke
                    renders identically on web/iOS/Android. */}
                <Svg width={112} height={112} pointerEvents="none" style={{ position: 'absolute' }}>
                  <Defs>
                    <LinearGradient id="playBevel" x1="0" y1="0" x2="1" y2="1">
                      <Stop offset="0" stopColor={colors.white} stopOpacity={0.4} />
                      <Stop offset="0.5" stopColor={colors.white} stopOpacity={0} />
                      <Stop offset="1" stopColor={colors.white} stopOpacity={0.4} />
                    </LinearGradient>
                  </Defs>
                  <Circle
                    cx={56}
                    cy={56}
                    r={55}
                    fill="none"
                    stroke="url(#playBevel)"
                    strokeWidth={2}
                  />
                </Svg>
                <Icon name={isPlaying ? 'pause' : 'play'} size={28} color={colors.white} />
              </Pressable>
              <Pressable
                onPress={() => void skipSeconds(skipForward)}
                className="items-center justify-center"
                hitSlop={8}
              >
                <View className="w-[48px] h-[48px] rounded-full items-center relative justify-center bg-gray-400/30 overflow-hidden border-4 border-r-0 border-b-2 border-r-transparent border-gray-400/15 shadow-inner">
                  <Icon
                    className="rotate-[141deg] absolute -top-0.5 -right-1"
                    name="triangle"
                    size={20}
                    color={'#9ca3af4d'}
                  />
                  <View className="absolute inset-0 items-center justify-center">
                    <Text variant="subtitle">+{skipForward}s</Text>
                  </View>
                </View>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
      {/* Footer (auto height): the secondary action row. Sits at the bottom
          because the middle above is flex-1 — no mt-auto hack needed. */}
      <View className="flex-row items-center justify-between px-8 py-2">
        <SpeedButton />
        <Pressable onPress={() => setSheet('history')} hitSlop={8} className="items-center gap-0.5">
          <Icon name="history" size={20} color={neutral} />
        </Pressable>
        <Pressable onPress={() => setSheet('notes')} hitSlop={8} className="items-center gap-0.5">
          <Icon name="notes" size={20} color={neutral} />
        </Pressable>
        <SleepTimerButton />
      </View>

      {/* In-view overlay rather than a nested RN <Modal>: a Modal inside the
          native full-screen player modal won't present on iOS. */}
      {sheet !== null ? (
        <View className="absolute inset-0 justify-end">
          <Pressable className="absolute inset-0 bg-black/40" onPress={() => setSheet(null)} />
          <View className="max-h-[75%] rounded-t-2xl bg-gray-100 p-4 dark:bg-gray-840">
            <ScrollView contentContainerClassName="pb-4" keyboardShouldPersistTaps="handled">
              {sheet === 'bookmarks' ? (
                <BookmarksSection
                  libraryId={libraryId}
                  path={path}
                  emptyLabel="No bookmarks yet."
                  onAdd={onAddBookmark}
                  adding={addBookmark.isPending}
                  addLabel={
                    savedBookmark
                      ? 'Bookmark saved'
                      : `Add bookmark at ${formatClock(bookPosition)}`
                  }
                />
              ) : null}
              {sheet === 'history' ? (
                <HistorySection libraryId={libraryId} path={path} emptyLabel="No history yet." />
              ) : null}
              {sheet === 'notes' ? <NotesSection libraryId={libraryId} path={path} /> : null}
            </ScrollView>
          </View>
        </View>
      ) : null}
    </View>
  );
}
