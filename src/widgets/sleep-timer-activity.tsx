import { HStack, Image, RoundedRectangle, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  activityBackgroundTint,
  aspectRatio,
  clipShape,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  minimumScaleFactor,
  monospacedDigit,
  multilineTextAlignment,
  padding,
  resizable,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityEnvironment } from 'expo-widgets';

import type { SleepTimerActivityProps } from './widget-model';

/**
 * The sleep timer Live Activity: the book, its chapter and the countdown, on
 * the lock screen and in the Dynamic Island, while a sleep timer counts down. Started by
 * the app in the foreground when a timer is set, ended the moment it fires or is
 * cancelled (`widget-sync.ios.ts`).
 *
 * The countdown is `Text(timerInterval:pauseTime:countsDown:)`: the SYSTEM ticks it, so
 * the app sends nothing per second, only a new `endsAt` when the end moves (an extension,
 * a seek or a speed change under an end-of-chapter timer) and `pausedAt` while the book
 * is paused (a frozen countdown). Its lower bound is a day before the end, which only
 * has to be in the past: a count-down timer shows `upper - now`.
 *
 * Like the widget, this function is a `'widget'` source string run by the extension (see
 * `continue-listening.tsx`): no hooks, nothing from module scope, plain expressions, every
 * string in `props`. System font (the app's fonts are not in the extension). The lock
 * screen banner follows the system light/dark scheme; the Dynamic Island is always dark.
 * The moon is the one pink thing.
 *
 * `widgetURL` sits on the banner and the expanded regions: expo-widgets 56 puts the start
 * URL on the Dynamic Island configuration only (#48400), so without it a lock screen tap
 * opens the app without the link.
 */
const SleepTimerActivity = (
  props: SleepTimerActivityProps,
  environment: LiveActivityEnvironment,
) => {
  'widget';
  const dark = environment.colorScheme === 'dark';
  const card = dark ? '#10172b' : '#ffffff';
  const fg = dark ? '#e7ebf4' : '#121c36';
  const muted = dark ? '#8f9ab3' : '#5b6680';
  const well = dark ? '#151d34' : '#eef1f5';
  const brand = dark ? '#ec4f95' : '#db2777';
  // The Dynamic Island is black in both schemes.
  const islandFg = '#ffffff';
  const islandMuted = '#a7b0c4';
  const islandBrand = '#ec4f95';

  const interval = { lower: new Date(props.endsAt - 86400000), upper: new Date(props.endsAt) };
  const pause = props.pausedAt ? new Date(props.pausedAt) : undefined;
  const countdown = (size: number, color: string, width: number) => (
    <Text
      timerInterval={interval}
      pauseTime={pause}
      countsDown
      modifiers={[
        font({ size: size, weight: 'semibold' }),
        monospacedDigit(),
        foregroundStyle(color),
        multilineTextAlignment('trailing'),
        minimumScaleFactor(0.6),
        lineLimit(1),
        frame({ width: width, alignment: 'trailing' }),
      ]}
    />
  );

  const cover = (size: number, background: string) => (
    <ZStack modifiers={[frame({ width: size, height: size })]}>
      <RoundedRectangle
        cornerRadius={8}
        modifiers={[foregroundStyle(background), frame({ width: size, height: size })]}
      />
      <Image systemName="moon.zzz.fill" size={size / 2.6} color={brand} />
      {props.coverFile ? (
        <Image
          uiImage={props.coverFile}
          modifiers={[
            resizable(),
            aspectRatio({ ratio: 1, contentMode: 'fill' }),
            frame({ width: size, height: size }),
            clipShape('roundedRectangle', 8),
          ]}
        />
      ) : null}
    </ZStack>
  );

  const titles = (color: string, secondary: string) => (
    <VStack alignment="leading" spacing={2}>
      <Text
        modifiers={[font({ size: 15, weight: 'semibold' }), foregroundStyle(color), lineLimit(1)]}
      >
        {props.title}
      </Text>
      {props.chapterTitle ? (
        <Text modifiers={[font({ size: 13 }), foregroundStyle(secondary), lineLimit(1)]}>
          {props.chapterTitle}
        </Text>
      ) : null}
    </VStack>
  );

  return {
    banner: (
      <HStack
        spacing={12}
        modifiers={[padding({ all: 16 }), activityBackgroundTint(card), widgetURL(props.deepLink)]}
      >
        {cover(48, well)}
        <VStack alignment="leading" spacing={2}>
          <HStack spacing={4}>
            <Image systemName="moon.zzz.fill" size={11} color={brand} />
            <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(muted)]}>
              {props.label}
            </Text>
          </HStack>
          {titles(fg, muted)}
        </VStack>
        <Spacer />
        {countdown(28, fg, 110)}
      </HStack>
    ),
    compactLeading: <Image systemName="moon.zzz.fill" size={14} color={islandBrand} />,
    compactTrailing: countdown(14, islandFg, 56),
    minimal: countdown(11, islandFg, 36),
    expandedLeading: (
      <VStack modifiers={[padding({ leading: 4, top: 4 }), widgetURL(props.deepLink)]}>
        {cover(44, '#1d2640')}
      </VStack>
    ),
    expandedCenter: (
      <VStack alignment="leading" modifiers={[widgetURL(props.deepLink)]}>
        {titles(islandFg, islandMuted)}
      </VStack>
    ),
    expandedTrailing: (
      <VStack modifiers={[padding({ trailing: 4, top: 4 }), widgetURL(props.deepLink)]}>
        {countdown(22, islandFg, 96)}
      </VStack>
    ),
  };
};

export const SleepTimerLiveActivity = createLiveActivity<SleepTimerActivityProps>(
  'SleepTimer',
  SleepTimerActivity,
);
