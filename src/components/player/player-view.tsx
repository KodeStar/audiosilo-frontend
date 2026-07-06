import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text as RNText, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

import { useAddBookmark } from '@/api/hooks';
import { useApi } from '@/api/provider';
import { BookmarksSection } from '@/components/library/bookmarks-section';
import { HistorySection } from '@/components/library/history-section';
import { NotesSection } from '@/components/library/notes-section';
import { ChapterListSheet, type ChapterItem } from '@/components/player/chapter-list';
import { CoverBackdrop } from '@/components/player/cover-backdrop';
import { SeekBar } from '@/components/player/seek-bar';
import { SkipButton } from '@/components/player/skip-button';
import { SleepSheet, SleepTimerButton } from '@/components/player/sleep-timer-button';
import { SpeedButton, SpeedSheet } from '@/components/player/speed-button';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { formatClock } from '@/lib/format';
import { pathLeaf } from '@/lib/paths';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import { wallClockSeconds } from '@/playback/rate';
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

/** Tabular numerals so times line up and don't jitter as digits change. */
const TABULAR = { fontVariant: ['tabular-nums' as const] };

type PlayerSheet = 'history' | 'notes' | 'bookmarks' | 'chapters' | 'speed' | 'sleep' | null;

/** Duration of the play/pause icon morph. */
const MORPH_MS = 140;

/**
 * The play/pause glyph inside the big pink button, crossfading + scaling (0.8->1)
 * between the two icons when playback flips - a small tactile "morph" rather than a
 * hard swap. Both glyphs are stacked and their opacity/scale driven by one shared
 * value (0 = play, 1 = pause). Reduced-motion collapses to an instant swap. The
 * button's loading state renders a Spinner instead of this, so that path is
 * untouched.
 */
function PlayPauseIcon({ playing }: { playing: boolean }) {
  const reduced = useReducedMotion();
  const p = useSharedValue(playing ? 1 : 0);
  useEffect(() => {
    const to = playing ? 1 : 0;
    p.value = reduced
      ? to
      : withTiming(to, { duration: MORPH_MS, easing: Easing.out(Easing.ease) });
  }, [playing, reduced, p]);

  const playStyle = useAnimatedStyle(() => ({
    opacity: 1 - p.value,
    transform: [{ scale: 0.8 + 0.2 * (1 - p.value) }],
  }));
  const pauseStyle = useAnimatedStyle(() => ({
    opacity: p.value,
    transform: [{ scale: 0.8 + 0.2 * p.value }],
  }));

  return (
    <View style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[{ position: 'absolute' }, playStyle]}>
        <Icon name="play" size={28} color={colors.white} />
      </Animated.View>
      <Animated.View style={[{ position: 'absolute' }, pauseStyle]}>
        <Icon name="pause" size={28} color={colors.white} />
      </Animated.View>
    </View>
  );
}

/**
 * The full transport for the currently-playing book, driven by the player store.
 * Rendered inside the player modal (phone) and as the right-hand panel on the
 * desktop book screen - identical everywhere except the close button, which the
 * phone modal supplies via `onClose` (the desktop panel has nothing to close).
 *
 * The body is an ambient "listening room": a blurred rendition of the cover fills
 * the background under a scrim, the cover floats, and the transport sits directly
 * on the atmosphere. All sheets are mounted at this view's root (the shared bottom
 * `Sheet` renders inline, so it must sit at a top-level position, not nested in a
 * footer control).
 */
export function PlayerView({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const { height } = useWindowDimensions();
  // The player fills the screen edge-to-edge (backdrop under the status bar); the
  // top controls + footer pad themselves clear of the notch / home indicator.
  const insets = useSafeAreaInsets();
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;
  const [sheet, setSheet] = useState<PlayerSheet>(null);
  // Live scrub preview (segment-relative seconds) while dragging the seek bar; the
  // time labels track it, and it commits on release.
  const [scrubPreview, setScrubPreview] = useState<number | null>(null);
  // Brief "saved" confirmation after adding a bookmark; the ref lets a rapid
  // second add reset the timer instead of stacking timeouts.
  const [savedBookmark, setSavedBookmark] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const nowPlaying = usePlayer((s) => s.nowPlaying);
  // Resolve the PLAYING book's connection, not the active one: a book keeps playing
  // through a connection the user has switched away from, and bookmarks/notes/history +
  // the cover auth must address that book's own server. Falls back to the active client
  // while nowPlaying is briefly null (loading).
  const api = useApi(nowPlaying?.connectionId);
  const bookPosition = usePlayer(selectBookPosition);
  const currentChapter = usePlayer(selectCurrentChapter);
  const isPlaying = usePlayer(selectIsPlaying);
  const trackIndex = usePlayer((s) => s.snapshot.trackIndex);
  const trackPos = usePlayer((s) => s.snapshot.position);
  const trackDur = usePlayer((s) => s.snapshot.duration);
  const rate = usePlayer((s) => s.rate);
  const playbackState = usePlayer((s) => s.snapshot.state);
  const toggle = usePlayer((s) => s.toggle);
  const retry = usePlayer((s) => s.retry);
  const seekBook = usePlayer((s) => s.seekBook);
  const seekInTrack = usePlayer((s) => s.seekInTrack);
  const goToTrack = usePlayer((s) => s.goToTrack);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const canRoutePick = usePlayer((s) => s.canRoutePick);
  const showRoutePicker = usePlayer((s) => s.showRoutePicker);
  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const sleepActive = useSleepTimer((s) => s.active);
  const sleepRemaining = useSleepTimer((s) => s.remaining);
  useShakeToCancel();
  // Keyed to the playing book; placeholders keep hook order stable before the
  // early return below (nowPlaying is null only briefly while loading).
  const addBookmark = useAddBookmark(
    nowPlaying?.libraryId ?? -1,
    nowPlaying?.path ?? '',
    nowPlaying?.connectionId,
  );

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

  // Entrance: once the view mounts with a loaded book, the cover scales up + fades
  // in, and the title / transport rise + fade with a slight stagger. Fires a single
  // time (guarded by `entered`), not on every track change - the view stays mounted
  // as tracks change. Reduced-motion snaps straight to the resting state.
  const reduced = useReducedMotion();
  const entered = useRef(false);
  const hasBook = !!nowPlaying;
  const coverV = useSharedValue(reduced ? 1 : 0);
  const titleV = useSharedValue(reduced ? 1 : 0);
  const transportV = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (!hasBook || entered.current) return;
    entered.current = true;
    if (reduced) {
      coverV.value = 1;
      titleV.value = 1;
      transportV.value = 1;
      return;
    }
    const cfg = { duration: 280, easing: Easing.out(Easing.cubic) };
    coverV.value = withTiming(1, cfg);
    titleV.value = withDelay(60, withTiming(1, cfg));
    transportV.value = withDelay(120, withTiming(1, cfg));
  }, [hasBook, reduced, coverV, titleV, transportV]);

  const coverStyle = useAnimatedStyle(() => ({
    opacity: coverV.value,
    transform: [{ scale: 0.94 + 0.06 * coverV.value }],
  }));
  const titleStyle = useAnimatedStyle(() => ({
    opacity: titleV.value,
    transform: [{ translateY: (1 - titleV.value) * 12 }],
  }));
  const transportStyle = useAnimatedStyle(() => ({
    opacity: transportV.value,
    transform: [{ translateY: (1 - transportV.value) * 12 }],
  }));

  if (!nowPlaying) return <Spinner center />;

  const { queue, title, author, cover, libraryId, path, connectionId } = nowPlaying;
  const total = queue.total;
  const coverSource = cover ? { uri: cover, headers: api.authHeaders() } : null;
  const rateLabel = `${Number(rate.toFixed(2))}×`;
  // When file durations are unknown (total 0), the whole-book timeline isn't
  // reliable - drive the UI from the engine's current-track position/duration
  // and navigate per-file instead.
  const perTrack = total <= 0;
  // The engine reports 'error' when a stream fails (e.g. became unreachable mid-
  // playback). Surface it with a retry rather than silently sitting on a dead
  // stream where the play button does nothing. While buffering ('loading') show a
  // spinner so a stall reads as "working", not an idle play button.
  const isError = playbackState === 'error';
  const isLoading = playbackState === 'loading';

  const segStart = currentChapter ? currentChapter.book_offset : 0;
  const segLength = perTrack
    ? Math.max(1, trackDur)
    : currentChapter
      ? Math.max(1, currentChapter.end - currentChapter.start)
      : total;
  const segElapsedRaw = perTrack
    ? trackPos
    : Math.max(0, Math.min(segLength, bookPosition - segStart));
  // While scrubbing, the labels preview the drag position.
  const segElapsed = scrubPreview ?? segElapsedRaw;
  const segRemaining = Math.max(0, segLength - segElapsed);
  const bookLeft = wallClockSeconds(total - bookPosition, rate);
  const centerLabel = perTrack
    ? t('player.controls.fileOf', { current: trackIndex + 1, total: queue.tracks.length })
    : t('player.controls.timeLeft', { time: formatClock(bookLeft), rate: rateLabel });
  const onSeek = (p: number) => (perTrack ? void seekInTrack(p) : void seekBook(segStart + p));

  // Title line: the current chapter, else the current file's name.
  const track = queue.tracks[trackIndex];
  const trackName = track ? pathLeaf(track.id.split(':').slice(1).join(':')) || title : title;
  const segTitleRaw = currentChapter
    ? currentChapter.title ||
      t('player.chapters.chapterNumber', { number: currentChapter.index + 1 })
    : trackName;
  const segTitle = prettifyChapterTitle(segTitleRaw);
  const secondaryLine = author ? `${title} · ${author}` : title;

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

  // Tapping the chapter title opens a list of all chapters (or files, when the
  // book has no chapters), scrolled to the current one.
  const chapterItems: ChapterItem[] = perTrack
    ? queue.tracks.map((track, i) => ({
        key: `t${i}`,
        label:
          pathLeaf(track.id.split(':').slice(1).join(':')) ||
          t('player.controls.fileNumber', { number: i + 1 }),
      }))
    : queue.chapters.map((c) => ({
        key: `c${c.index}`,
        label: c.title || t('player.chapters.chapterNumber', { number: c.index + 1 }),
        sublabel: formatClock(c.book_offset),
      }));
  const chapterCurrentIndex = perTrack ? trackIndex : (currentChapter?.index ?? 0);
  const hasChapterList = chapterItems.length > 1;
  const onSelectChapter = (i: number) => {
    if (perTrack) return void goToTrack(i);
    const c = queue.chapters[i];
    if (c) void seekBook(c.book_offset);
  };

  const sheetMax = Math.round(height * 0.7);

  return (
    <View className="flex-1">
      <CoverBackdrop source={coverSource} />

      {/* Header (auto height). The close button is mobile-only; the right side is
          the shared action area (notes + bookmarks). Padded below the status-bar
          inset so it clears the notch (the backdrop paints under it). */}
      <View className="flex-row items-center px-4 py-2" style={{ paddingTop: insets.top + 8 }}>
        {onClose ? (
          <AnimatedPressable
            onPress={onClose}
            hitSlop={12}
            className="h-9 w-9 items-center justify-center"
            accessibilityRole="button"
            accessibilityLabel={t('player.controls.close')}
          >
            <Icon name="chevron-down" size={26} color={neutral} />
          </AnimatedPressable>
        ) : null}
        <View className="ml-auto flex-row items-center gap-2">
          <AnimatedPressable
            onPress={() => setSheet('notes')}
            hitSlop={8}
            className="h-9 w-9 items-center justify-center"
            accessibilityRole="button"
            accessibilityLabel={t('player.notes.label')}
          >
            <Icon name="notes" size={20} color={neutral} />
          </AnimatedPressable>
          <AnimatedPressable
            onPress={() => setSheet('bookmarks')}
            hitSlop={8}
            className="h-9 w-9 items-center justify-center"
            accessibilityRole="button"
            accessibilityLabel={t('player.bookmarks.label')}
          >
            <Icon name="bookmark" size={20} color={neutral} />
          </AnimatedPressable>
        </View>
      </View>

      {/* Middle (flex-1, centered): the cover floats over the atmosphere, then the
          title stack, then the transport. justify-center keeps the group tight and
          absorbs leftover height symmetrically (web window vs tall phone). */}
      <View className="flex-1 items-center justify-center gap-6 px-6">
        <Animated.View style={[{ width: '100%', alignItems: 'center' }, coverStyle]}>
          <View className="w-full max-w-[320px]">
            <View className="aspect-square overflow-hidden rounded-lg border border-black/10 shadow-lg dark:border-white/10">
              <Cover source={coverSource} label={title} rounded="rounded-lg" />
            </View>
            {sleepActive && sleepRemaining !== null ? (
              <View className="absolute right-2 top-2 flex-row items-center gap-1 rounded-full bg-black/60 px-2 py-1">
                <Icon name="sleep" size={12} color={colors.white} />
                {/* Raw RN Text + explicit classes: the themed <Text> variant injects
                    its own text color, which NativeWind won't reliably override with an
                    appended one - so a specific color must not go through <Text>. */}
                <RNText className="font-sans text-xs text-white dark:text-white" style={TABULAR}>
                  {formatClock(sleepRemaining)}
                </RNText>
              </View>
            ) : null}
          </View>
        </Animated.View>

        {/* Title hierarchy: prettified chapter/track title (primary), then
            book title · author (muted secondary). */}
        <Animated.View style={[{ width: '100%', alignItems: 'center' }, titleStyle]}>
          <View className="w-full max-w-[420px] items-center gap-1">
            {hasChapterList ? (
              <AnimatedPressable
                onPress={() => setSheet('chapters')}
                className="flex-row items-center justify-center gap-2 px-2"
                accessibilityRole="button"
                accessibilityLabel={t('player.controls.showChapters')}
              >
                <Text variant="heading" className="text-center" numberOfLines={2}>
                  {segTitle}
                </Text>
                <Icon name="list" size={14} color={neutral} />
              </AnimatedPressable>
            ) : (
              <Text variant="heading" className="text-center" numberOfLines={2}>
                {segTitle}
              </Text>
            )}
            <Text variant="muted" className="text-center" numberOfLines={1}>
              {secondaryLine}
            </Text>
          </View>
        </Animated.View>

        {/* Transport */}
        <Animated.View style={[{ width: '100%', alignItems: 'center' }, transportStyle]}>
          <View className="w-full max-w-[420px] gap-1">
            <SeekBar
              position={segElapsed}
              duration={segLength}
              onSeek={onSeek}
              onScrub={setScrubPreview}
            />
            <View className="flex-row items-center justify-between">
              <Text variant="caption" style={TABULAR}>
                {formatClock(segElapsed)}
              </Text>
              <Text variant="caption" className="flex-1 text-center" style={TABULAR}>
                {centerLabel}
              </Text>
              <Text variant="caption" style={TABULAR}>
                -{formatClock(segRemaining)}
              </Text>
            </View>

            {isError ? (
              <View className="mt-3 flex-row items-center justify-center gap-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
                <RNText className="font-sans text-xs text-danger-600 dark:text-danger">
                  {t('ui.error')}
                </RNText>
                <AnimatedPressable
                  onPress={() => void retry()}
                  className="rounded-lg bg-primary px-4 py-1.5"
                  accessibilityRole="button"
                >
                  <RNText className="font-roboto-medium text-base text-white dark:text-white">
                    {t('common.retry')}
                  </RNText>
                </AnimatedPressable>
              </View>
            ) : null}

            <View className="flex-row items-center justify-between py-6">
              <AnimatedPressable
                onPress={goPrev}
                hitSlop={8}
                className="h-11 w-11 items-center justify-center rounded-full"
                accessibilityRole="button"
                accessibilityLabel={t('player.controls.previous')}
              >
                <Icon name="prev" size={22} color={neutral} />
              </AnimatedPressable>

              <SkipButton
                direction="back"
                seconds={skipBackward}
                onPress={() => void skipSeconds(-skipBackward)}
                color={neutral}
                glyphSize={38}
                className="h-12 w-12 items-center justify-center rounded-full"
                accessibilityLabel={t('player.controls.skipBack', { seconds: skipBackward })}
              />

              <AnimatedPressable
                onPress={() => (isError ? void retry() : void toggle())}
                className="h-[112px] w-[112px] items-center justify-center rounded-full bg-primary"
                accessibilityRole="button"
                accessibilityLabel={
                  isPlaying ? t('player.controls.pause') : t('player.controls.play')
                }
              >
                {/* Diagonal bevel highlight. Drawn as an SVG ring with a 135°
                  white->transparent->white gradient stroke rather than per-side
                  borders + rotation: iOS clips a non-uniform border on a fully
                  rounded view, so the bevel rendered cropped there while web was
                  fine. An SVG stroke renders identically on web/iOS/Android. */}
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
                {isLoading ? (
                  <Spinner size="large" color={colors.white} />
                ) : (
                  <PlayPauseIcon playing={isPlaying} />
                )}
              </AnimatedPressable>

              <SkipButton
                direction="forward"
                seconds={skipForward}
                onPress={() => void skipSeconds(skipForward)}
                color={neutral}
                glyphSize={38}
                className="h-12 w-12 items-center justify-center rounded-full"
                accessibilityLabel={t('player.controls.skipForward', { seconds: skipForward })}
              />

              <AnimatedPressable
                onPress={goNext}
                hitSlop={8}
                className="h-11 w-11 items-center justify-center rounded-full"
                accessibilityRole="button"
                accessibilityLabel={t('player.controls.next')}
              >
                <Icon name="next" size={22} color={neutral} />
              </AnimatedPressable>
            </View>
          </View>
        </Animated.View>
      </View>

      {/* Footer (auto height): the secondary action row. Padded past the home
          indicator so the controls clear it. */}
      <View
        className="flex-row items-center justify-between px-8 py-2"
        style={{ paddingBottom: insets.bottom + 8 }}
      >
        <SpeedButton onPress={() => setSheet('speed')} />
        <AnimatedPressable
          onPress={() => setSheet('history')}
          hitSlop={8}
          className="items-center gap-0.5"
          accessibilityRole="button"
          accessibilityLabel={t('player.history.label')}
        >
          <Icon name="history" size={20} color={neutral} />
        </AnimatedPressable>
        {/* AirPlay / cast: shown only where the engine can present a picker. A
            spacer keeps the row balanced when it's hidden. */}
        {canRoutePick ? (
          <AnimatedPressable
            onPress={() => void showRoutePicker()}
            hitSlop={8}
            className="items-center gap-0.5"
            accessibilityRole="button"
            accessibilityLabel={t('player.routePicker.label')}
          >
            <Icon name="airplay" size={20} color={neutral} />
          </AnimatedPressable>
        ) : (
          <View className="w-5" />
        )}
        <SleepTimerButton onPress={() => setSheet('sleep')} />
      </View>

      {/* Sheets, all mounted at the root so the shared bottom Sheet presents
          correctly (it renders inline, not as an RN Modal). */}
      <Sheet
        inline
        visible={sheet === 'bookmarks'}
        onClose={() => setSheet(null)}
        title={t('player.bookmarks.label')}
      >
        <ScrollView
          style={{ maxHeight: sheetMax }}
          contentContainerClassName="px-4 pb-4"
          keyboardShouldPersistTaps="handled"
        >
          <BookmarksSection
            libraryId={libraryId}
            path={path}
            connectionId={connectionId}
            emptyLabel={t('player.bookmarks.empty')}
            onAdd={onAddBookmark}
            adding={addBookmark.isPending}
            addLabel={
              savedBookmark
                ? t('player.bookmarks.saved')
                : t('player.bookmarks.addAt', { time: formatClock(bookPosition) })
            }
          />
        </ScrollView>
      </Sheet>

      <Sheet
        inline
        visible={sheet === 'history'}
        onClose={() => setSheet(null)}
        title={t('player.history.label')}
      >
        <ScrollView
          style={{ maxHeight: sheetMax }}
          contentContainerClassName="px-4 pb-4"
          keyboardShouldPersistTaps="handled"
        >
          <HistorySection
            libraryId={libraryId}
            path={path}
            connectionId={connectionId}
            emptyLabel={t('player.history.empty')}
            chapters={queue.chapters}
          />
        </ScrollView>
      </Sheet>

      <Sheet
        inline
        visible={sheet === 'notes'}
        onClose={() => setSheet(null)}
        title={t('player.notes.label')}
      >
        <ScrollView
          style={{ maxHeight: sheetMax }}
          contentContainerClassName="px-4 pb-4"
          keyboardShouldPersistTaps="handled"
        >
          <NotesSection libraryId={libraryId} path={path} connectionId={connectionId} />
        </ScrollView>
      </Sheet>

      <ChapterListSheet
        visible={sheet === 'chapters'}
        title={perTrack ? t('player.chapters.filesTitle') : t('player.chapters.chaptersTitle')}
        items={chapterItems}
        currentIndex={chapterCurrentIndex}
        onSelect={onSelectChapter}
        onClose={() => setSheet(null)}
      />

      <SpeedSheet visible={sheet === 'speed'} onClose={() => setSheet(null)} />
      <SleepSheet visible={sheet === 'sleep'} onClose={() => setSheet(null)} />
    </View>
  );
}
