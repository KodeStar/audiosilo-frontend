import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useBook } from '@/api/hooks';
import { BookCover } from '@/components/library/book-cover';
import { CoverWash } from '@/components/library/cover-wash';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { chapterLabel } from '@/lib/chapter-label';
import { useLayout } from '@/lib/layout';
import { pathLeaf } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import { selectCurrentChapter, selectIsPlaying, usePlayer } from '@/playback/store';
import { useThemeColors } from '@/theme/use-theme-colors';

import { PlayerBookTimeline } from './book-timeline';
import { Companion } from './companion/companion';
import { GraceCard, useGraceCardOpen } from './grace-card';
import {
  CompanionChips,
  PlayerActions,
  PlayerColumn,
  PlayerErrorLine,
  PlayerHeader,
  PlayerStatusLine,
} from './player-parts';
import { PlayerSheetHost } from './player-sheet-host';
import { usePlayerSheets } from './player-sheets';
import {
  COMPANION_WIDTH,
  PHONE_COVER_MIN,
  PHONE_COVER_ROOM,
  phoneCoverSize,
  playerCoverSize,
  playerLayout,
  playerWash,
} from './player-view-model';
import { PlayerSeekBar } from './seek-bar';
import { TransportControls } from './transport-controls';
import { usePlayingPins } from './use-playing-pins';

/** `--dur-4` (STYLEGUIDE section 6): the cover's breathe and the player's rise. */
const BREATHE_MS = 520;

/**
 * The cover, breathing (STYLEGUIDE section 6): it settles to 94% while paused and comes
 * back to full size when the book plays. Reduced motion keeps it still.
 */
function BreathingCover({ size, coverVersion }: { size: number; coverVersion?: string }) {
  const np = usePlayer((s) => s.nowPlaying);
  const playing = usePlayer(selectIsPlaying);
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  useEffect(() => {
    const to = reduced || playing ? 1 : 0.94;
    scale.value = reduced
      ? to
      : withTiming(to, { duration: BREATHE_MS, easing: Easing.bezier(0.2, 0.8, 0.2, 1) });
  }, [playing, reduced, scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  if (!np) return null;
  return (
    <Animated.View style={style}>
      <BookCover
        connectionId={np.connectionId}
        libraryId={np.libraryId}
        path={np.path}
        coverVersion={coverVersion}
        width={size}
        title={np.title}
        author={np.author}
        shadow="lg"
      />
    </Animated.View>
  );
}

/** The chapter title (tap for the chapters) and "book · author". */
function PlayerTitles({ phone, onChapters }: { phone: boolean; onChapters: () => void }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const np = usePlayer((s) => s.nowPlaying);
  const chapter = usePlayer(selectCurrentChapter);
  const trackIndex = usePlayer((s) => s.snapshot.trackIndex);
  if (!np) return null;
  const { queue, title, author } = np;
  const track = queue.tracks[trackIndex];
  const trackName = track ? pathLeaf(track.id.split(':').slice(1).join(':')) || title : title;
  const heading = chapter ? chapterLabel(chapter, t) : prettifyChapterTitle(trackName);
  const many = queue.chapters.length > 1 || queue.tracks.length > 1;
  const titleClass = cn(
    'text-center',
    phone ? 'text-[23px] leading-[27px]' : 'text-[30px] leading-[34px]',
  );
  return (
    <View className="w-full items-center gap-1">
      {many ? (
        <AnimatedPressable
          onPress={onChapters}
          accessibilityRole="button"
          accessibilityLabel={t('player.full.chapterButton', { chapter: heading })}
          className="max-w-full flex-row items-center justify-center gap-1.5 rounded-control px-2"
        >
          <Text variant="display" className={titleClass} numberOfLines={2}>
            {heading}
          </Text>
          <Icon name="chevron-down" size={18} color={themed.mutedForeground} />
        </AnimatedPressable>
      ) : (
        <Text variant="display" className={titleClass} numberOfLines={2}>
          {heading}
        </Text>
      )}
      <Text variant="muted" className="text-center" numberOfLines={1}>
        {author ? `${title} · ${author}` : title}
      </Text>
    </View>
  );
}

/**
 * The full player (STYLEGUIDE section 8, "Full player"), the root modal's view of the
 * PLAYING book: its cover washed into the background, the cover breathing (94% when
 * paused), the chapter title (tap for the chapters), the status line (or the Undo chip
 * after a jump), the chapter seek bar with its times, the compact whole-book timeline,
 * the transport and the actions. The companion (Who's who, Story so far, Chapters,
 * Bookmarks, Notes, History) is a 420 column on a desktop, sits below the controls on a
 * tablet and opens as a sheet from chips on a phone. The layout follows the player's
 * MEASURED width. Its sheets render here (`PlayerSheetHost`), above the shell's.
 */
export function PlayerView({ onClose }: { onClose: () => void }) {
  const themed = useThemeColors();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const layout = playerLayout(width, useLayout());
  const phone = layout === 'phone';
  const desktop = layout === 'desktop';
  const np = usePlayer((s) => s.nowPlaying);
  const { data: book } = useBook(np?.libraryId ?? -1, np?.path ?? '', np?.connectionId);
  const graceOpen = useGraceCardOpen();
  // The seek bar's scrub (or hover) tip floats into the status slot above it, the
  // timeline's into the seek bar's times row: each makes way while its tip shows, so a tip
  // never sits on top of words.
  const [tip, setTip] = useState(false);
  const [timelineTip, setTimelineTip] = useState(false);
  // The playing book's bookmarks and notes, once for both scrubbers.
  const pins = usePlayingPins();
  // A phone's column is a flex column filling the viewport: the cover's slot takes what
  // the rest leaves (measured), so the player fits a phone without scrolling; the column
  // scrolls only once the slot is at its minimum.
  const [coverSlot, setCoverSlot] = useState(0);

  // Entrance: the cover scales up and fades in, the titles and the controls rise after
  // it, once per open (the view stays mounted as chapters change). Reduced motion
  // starts at rest.
  const reduced = useReducedMotion();
  const entered = useRef(false);
  const hasBook = !!np;
  const coverV = useSharedValue(reduced ? 1 : 0);
  const restV = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (!hasBook || entered.current) return;
    entered.current = true;
    if (reduced) {
      coverV.value = 1;
      restV.value = 1;
      return;
    }
    const cfg = { duration: 320, easing: Easing.bezier(0.2, 0.8, 0.2, 1) };
    coverV.value = withTiming(1, cfg);
    restV.value = withDelay(90, withTiming(1, cfg));
  }, [hasBook, reduced, coverV, restV]);
  const coverStyle = useAnimatedStyle(() => ({
    opacity: coverV.value,
    transform: [{ scale: 0.94 + 0.06 * coverV.value }],
  }));
  const restStyle = useAnimatedStyle(() => ({
    opacity: restV.value,
    transform: [{ translateY: (1 - restV.value) * 12 }],
  }));

  if (!np) return <Spinner center />;

  // The chapters: the sheet host shows them where this layout keeps them.
  const onChapters = () => usePlayerSheets.getState().openSheet('chapters');
  const w = width || windowWidth;
  const bottomPad = insets.bottom + (phone ? 12 : 24);
  const coverSize = phone ? phoneCoverSize(w, coverSlot) : playerCoverSize(layout, w, height);
  const wash = playerWash(book?.cover_color, themed.mutedForeground, themed.brand);

  const main = (
    <PlayerColumn maxWidth={desktop ? 640 : 560} fill={phone}>
      {phone ? (
        <Animated.View
          testID="player-cover-slot"
          style={[coverStyle, { minHeight: PHONE_COVER_MIN + PHONE_COVER_ROOM }]}
          className="w-full flex-1 items-center justify-center"
          onLayout={(e) => setCoverSlot(e.nativeEvent.layout.height)}
        >
          {coverSize > 0 ? (
            <BreathingCover size={coverSize} coverVersion={book?.cover_version} />
          ) : null}
        </Animated.View>
      ) : (
        <Animated.View style={coverStyle} className="py-2">
          <BreathingCover size={coverSize} coverVersion={book?.cover_version} />
        </Animated.View>
      )}
      <Animated.View style={restStyle} className="w-full items-center gap-3">
        <PlayerTitles phone={phone} onChapters={onChapters} />
        {/* The sleep timer's last seconds take the status line's place: in the flow, so
            the card never covers the transport or the actions. */}
        <View
          testID="player-status-slot"
          className="w-full"
          style={tip ? { opacity: 0 } : undefined}
          aria-hidden={tip || undefined}
          importantForAccessibility={tip ? 'no-hide-descendants' : 'auto'}
        >
          {graceOpen ? <GraceCard inline /> : <PlayerStatusLine />}
        </View>
        <View className="w-full gap-3">
          <PlayerSeekBar
            bookmarks={pins.bookmarks}
            bars={phone ? 56 : 96}
            onTip={setTip}
            timesHidden={timelineTip}
          />
          <PlayerBookTimeline pins={pins} onTip={setTimelineTip} />
        </View>
        <TransportControls size={phone ? 'md' : 'lg'} className="py-1" />
        <PlayerErrorLine />
        <PlayerActions wide={!phone} upNext={!desktop} />
        {phone ? <CompanionChips /> : null}
      </Animated.View>
    </PlayerColumn>
  );

  return (
    <View
      testID={`player-${layout}`}
      className="flex-1 bg-background"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      <CoverWash color={wash} variant="hero" />
      <View style={{ paddingTop: insets.top }}>
        <PlayerHeader book={book} onClose={onClose} onChapters={onChapters} />
      </View>
      {desktop ? (
        <View className="flex-1 flex-row">
          <ScrollView
            className="flex-1"
            contentContainerClassName="flex-grow justify-center px-10 pb-8"
          >
            {main}
          </ScrollView>
          <View
            testID="player-companion-column"
            className="border-l border-border bg-card"
            style={{ width: COMPANION_WIDTH, paddingBottom: insets.bottom }}
          >
            <Companion variant="column" />
          </View>
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerClassName={phone ? 'grow px-5 pt-1' : 'px-12 pt-2'}
          contentContainerStyle={{ paddingBottom: bottomPad }}
        >
          {main}
          {!phone ? (
            <View
              testID="player-companion-inline"
              className="mt-8 w-full max-w-[720px] self-center rounded-card border border-border bg-card px-4"
            >
              <Companion variant="inline" />
            </View>
          ) : null}
        </ScrollView>
      )}
      <PlayerSheetHost scope="player" layout={layout} />
    </View>
  );
}
