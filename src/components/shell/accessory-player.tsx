import { router } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTranslation } from 'react-i18next';
import { useRef, useState } from 'react';
import { Dimensions, View } from 'react-native';

import { BookCover } from '@/components/library/book-cover';
import { ChapterProgressLine } from '@/components/player/chapter-progress';
import { MiniPlayerSubtitle, useMiniHeading } from '@/components/player/mini-player';
import { usePlayerOnTop } from '@/components/player/player-sheets';
import { SkipButton } from '@/components/player/skip-button';
import { PlayButton } from '@/components/player/transport-controls';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Text } from '@/components/ui/text';
import { useLayout } from '@/lib/layout';
import { usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';
import { useThemeColors } from '@/theme/use-theme-colors';

import { useChromeEdge } from './shell-metrics';

/**
 * The phone mini player in the iOS 26 tab bar's bottom accessory (a Liquid Glass pill
 * the system sizes, about 48 pt; STYLEGUIDE "Mini player"). iOS renders the accessory
 * TWICE - `regular` above the bar and `inline` beside the minimised bar - so this holds
 * no state of its own: every value comes from the player and sleep-timer stores, and each
 * copy is a pure function of them and the placement. `regular` has the mini card's
 * content (round cover, chapter, book with its time left or the sleep countdown first,
 * skip back, play/pause, the chapter progress line); the narrow `inline` keeps the cover,
 * the chapter and play/pause. Text and glyphs use the themed tokens (the glass follows
 * the app theme, which Uniwind applies to the native appearance).
 */
export function AccessoryPlayer() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const { t } = useTranslation();
  const themed = useThemeColors();
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const skipBackward = useSettings((s) => s.skipBackward);
  const { heading, isChapter } = useMiniHeading();
  // The tab bar (and so the accessory) is hidden on tablet/desktop, but iOS still renders
  // both placements: render nothing there, so no per-tick leaf runs behind it. Nor under
  // the full player (a root modal over the tabs).
  const phone = useLayout() === 'phone';
  const onTop = usePlayerOnTop();
  const shown = nowPlaying != null && phone && !onTop;
  const regular = placement === 'regular';

  // The pill above the bar (`regular`) publishes its top edge for the root toasts. It is
  // native chrome, so it is measured in the window; a reading outside the bottom half of
  // the window (a copy iOS is not showing) is ignored.
  const pill = useRef<View>(null);
  const [edge, setEdge] = useState<number>();
  useChromeEdge('accessory', shown ? edge : undefined, regular);
  const measure = () =>
    pill.current?.measureInWindow((_x, y, _w, h) => {
      const height = Dimensions.get('window').height;
      const top = height - y;
      setEdge(h > 0 && top > 0 && top < height / 2 ? top : undefined);
    });

  if (!shown) return null;

  return (
    <View
      ref={pill}
      onLayout={regular ? measure : undefined}
      testID={`accessory-player-${placement}`}
      className="flex-1 flex-row items-center gap-1 pl-1.5 pr-1"
    >
      <AnimatedPressable
        onPress={() => router.push('/player')}
        accessibilityRole="button"
        accessibilityLabel={t('shell.openPlayer', { title: nowPlaying.title })}
        className="min-w-0 flex-1 flex-row items-center gap-2.5 self-stretch"
      >
        <BookCover
          connectionId={nowPlaying.connectionId}
          libraryId={nowPlaying.libraryId}
          path={nowPlaying.path}
          width={regular ? 36 : 28}
          title={nowPlaying.title}
          className="rounded-full"
        />
        <View className="min-w-0 flex-1">
          <Text variant="label" className="text-[13.5px] leading-[17px]" numberOfLines={1}>
            {heading}
          </Text>
          {regular ? <MiniPlayerSubtitle title={nowPlaying.title} showTitle={isChapter} /> : null}
        </View>
      </AnimatedPressable>
      {regular ? (
        <SkipButton
          direction="back"
          seconds={skipBackward}
          onPress={() => void skipSeconds(-skipBackward)}
          color={themed.foreground}
          fontSize={12}
          hitSlop={2}
          className="h-10 w-10 items-center justify-center rounded-full"
          accessibilityLabel={t('player.controls.skipBack', { seconds: skipBackward })}
        />
      ) : null}
      <PlayButton size="sm" plain />
      {regular ? (
        <ChapterProgressLine className="absolute bottom-[3px] left-5 right-5 h-[2px]" />
      ) : null}
    </View>
  );
}
