import { router } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTranslation } from 'react-i18next';
import { useRef, useState } from 'react';
import { Dimensions, View } from 'react-native';

import { useApi } from '@/api/provider';
import { SkipButton } from '@/components/player/skip-button';
import { usePlayingTimeLeft } from '@/components/player/use-time-left';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLayout } from '@/lib/layout';
import { chapterLabel } from '@/lib/chapter-label';
import { selectCurrentChapter, selectIsPlaying, usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';
import { useThemeColors } from '@/theme/use-theme-colors';

import { useChromeEdge } from './shell-metrics';

/** "Title · 5h 27m left at 1.25×" (`usePlayingTimeLeft`). A leaf, so only this line
 * re-renders, and only when its text changes. */
function BookLine({ title }: { title: string }) {
  const left = usePlayingTimeLeft();
  return (
    <Text variant="caption" numberOfLines={1}>
      {left ? `${title} · ${left}` : title}
    </Text>
  );
}

/**
 * The phone mini player in the iOS 26 tab bar's bottom accessory (a Liquid Glass pill
 * the system sizes, about 48 pt). iOS renders the accessory TWICE - `regular` above the
 * bar and `inline` beside the minimised bar - so this holds no state of its own: every
 * value comes from the player store, and each copy is a pure function of it and the
 * placement. Text and glyphs use the themed tokens (the glass follows the app theme,
 * which Uniwind applies to the native appearance).
 */
export function AccessoryPlayer() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const { t } = useTranslation();
  const themed = useThemeColors();
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const isPlaying = usePlayer(selectIsPlaying);
  const chapter = usePlayer(selectCurrentChapter);
  const toggle = usePlayer((s) => s.toggle);
  const skipSeconds = usePlayer((s) => s.skipSeconds);
  const skipBackward = useSettings((s) => s.skipBackward);
  // The cover URL embeds the playing book's own server auth; match its headers to it.
  const api = useApi(nowPlaying?.connectionId);
  // The tab bar (and so the accessory) is hidden on tablet/desktop, but iOS still renders
  // both placements: render nothing there, so no per-tick leaf runs behind it.
  const phone = useLayout() === 'phone';
  const shown = nowPlaying != null && phone;
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

  const heading = chapter ? chapterLabel(chapter, t) : nowPlaying.title;

  return (
    <View
      ref={pill}
      onLayout={regular ? measure : undefined}
      testID={`accessory-player-${placement}`}
      className="flex-1 flex-row items-center gap-1 pl-2 pr-1.5"
    >
      <AnimatedPressable
        onPress={() => router.push('/player')}
        accessibilityRole="button"
        accessibilityLabel={t('shell.openPlayer', { title: nowPlaying.title })}
        className="flex-1 flex-row items-center gap-2.5"
      >
        <Cover
          source={{ uri: nowPlaying.cover, headers: api.authHeaders() }}
          label={nowPlaying.title}
          rounded="rounded-full"
          size={regular ? 34 : 28}
        />
        <View className="flex-1">
          <Text variant="label" numberOfLines={1}>
            {heading}
          </Text>
          {regular ? <BookLine title={nowPlaying.title} /> : null}
        </View>
      </AnimatedPressable>
      {regular ? (
        <SkipButton
          direction="back"
          seconds={skipBackward}
          onPress={() => void skipSeconds(-skipBackward)}
          color={themed.foreground}
          fontSize={12}
          className="h-10 w-10 items-center justify-center rounded-full"
          accessibilityLabel={t('player.controls.skipBack', { seconds: skipBackward })}
        />
      ) : null}
      <AnimatedPressable
        onPress={() => void toggle()}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? t('player.controls.pause') : t('player.controls.play')}
        className="h-10 w-10 items-center justify-center rounded-full"
      >
        <Icon
          name={isPlaying ? 'pause' : 'play'}
          size={regular ? 20 : 18}
          color={themed.foreground}
        />
      </AnimatedPressable>
    </View>
  );
}
