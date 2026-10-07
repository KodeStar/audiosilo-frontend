import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Platform, View } from 'react-native';
import Animated, { FadeInDown, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { bottomChromeTop, useChromeEdge, useShellMetrics } from '@/components/shell/shell-metrics';
import { toastBottomOffset } from '@/components/shell/toast-offset';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { useRootInsets } from '@/components/ui/overlay';
import { ProgressRing } from '@/components/ui/progress-ring';
import { Text } from '@/components/ui/text';
import {
  FADE_SECONDS,
  GRACE_SECONDS,
  selectSleepExtendable,
  selectSleepPhase,
  useSleepTimer,
} from '@/playback/sleep-timer';
import { useSettings } from '@/stores/settings';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

/** The card itself, mounted only while it shows, so its once-a-second countdown costs
 * nothing the rest of the time. */
function GraceCardBody() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const phase = useSleepTimer(selectSleepPhase);
  const remaining = useSleepTimer((s) => s.remaining);
  const fades = useSleepTimer((s) => s.origin?.kind === 'duration');
  const keepListening = useSleepTimer((s) => s.keepListening);
  const shakeOn = useSettings((s) => s.shakeToExtend);
  const shake = shakeOn && Platform.OS !== 'web';
  const seconds = Math.max(0, Math.ceil(remaining ?? 0));

  const title =
    phase === 'grace'
      ? t('player.sleepTimer.grace.pausedTitle')
      : fades
        ? t('player.sleepTimer.grace.fadingIn', { count: seconds })
        : t('player.sleepTimer.grace.stoppingIn', { count: seconds });
  const body =
    phase === 'grace'
      ? shake
        ? t('player.sleepTimer.grace.pausedShake')
        : t('player.sleepTimer.grace.paused')
      : shake
        ? t('player.sleepTimer.grace.stillAwakeShake')
        : t('player.sleepTimer.grace.stillAwake');

  // iOS has no live regions: say it once as each phase starts.
  useEffect(() => {
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(body);
  }, [body]);

  const windowSeconds = phase === 'grace' ? GRACE_SECONDS : FADE_SECONDS;
  return (
    <Animated.View
      entering={FadeInDown.duration(320).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(200).reduceMotion(ReduceMotion.System)}
      testID="sleep-grace-card"
      className="w-full max-w-[460px] flex-row items-center gap-3.5 rounded-[18px] border border-border bg-popover px-4 py-3.5 shadow-overlay"
    >
      {/* Empties over the window (decorative: the title says the same in words). */}
      <ProgressRing
        fraction={seconds / windowSeconds}
        size={42}
        stroke={4}
        color={themed.brand}
        trackColor={themed.border}
      >
        <Icon name="sleep" size={17} color={themed.foreground} />
      </ProgressRing>
      <View className="flex-1 gap-0.5">
        <Text variant="label" style={tabularNums}>
          {title}
        </Text>
        {/* The live region: its text changes with the phase, not every second, so a
              screen reader hears it once rather than a countdown. */}
        <Text variant="caption" aria-live="polite" accessibilityLiveRegion="polite">
          {body}
        </Text>
      </View>
      <Button size="sm" title={t('player.sleepTimer.keepListening')} onPress={keepListening} />
    </Animated.View>
  );
}

/** Whether the grace card is showing (the timer's last seconds or its grace window, the
 * windows a tap or a shake can keep the book going): the full player gives it the status
 * line's place, the shell floats it above the bottom chrome. */
export function useGraceCardOpen(): boolean {
  return useSleepTimer(selectSleepExtendable);
}

/**
 * The sleep timer's grace card (STYLEGUIDE section 8, "Sheets" > Sleep): shown in the
 * timer's last `FADE_SECONDS` (the `ending` phase) and in the post-pause `grace` window,
 * with a ring that empties over the window, what is about to happen ("Fading out in
 * 24 s", "Stopping in 24 s" for a chapter timer, which does not fade, or "Paused by the
 * sleep timer"), how to keep going (a shake, where the listener has it on and the device
 * has a sensor) and a Keep listening button. Renders nothing otherwise.
 *
 * `inline` lays it out in the flow: the full player puts it in its status line's place,
 * where it can never cover the transport or the actions at any width. Otherwise it
 * floats (`FloatingGraceCard`). It is not a dialog: it never takes focus and blocks
 * nothing outside its own box. It is announced politely instead (a live region on
 * Android and the web, an announcement on iOS, which has no live regions) - once per
 * phase, not once per second.
 */
export function GraceCard({ inline = false }: { inline?: boolean }) {
  const open = useGraceCardOpen();
  if (!open) return null;
  if (inline)
    return (
      <View className="w-full items-center">
        <GraceCardBody />
      </View>
    );
  return <FloatingGraceCard />;
}

/** The floating card: just above the bottom chrome the shell measured (the tab bar and
 * mini player on a phone, the docked bar on tablet and desktop), where a toast would
 * sit. It publishes its own top edge (`grace`), so the toasts lift above it while it
 * shows instead of landing on it. Mount it at the shell's root (it is positioned from
 * the window's bottom edge). */
function FloatingGraceCard() {
  const insets = useRootInsets();
  const chromeTop = useShellMetrics((s) => bottomChromeTop(s.edges, 'grace'));
  const [height, setHeight] = useState<number>();
  const bottom = toastBottomOffset({
    overTabs: true,
    hasChrome: true,
    safeBottom: insets.bottom,
    chromeTop,
  });
  useChromeEdge('grace', height === undefined ? undefined : bottom + height);
  return (
    <View
      testID="sleep-grace-float"
      pointerEvents="box-none"
      style={{ bottom }}
      className="absolute left-3 right-3 items-center"
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
    >
      <GraceCardBody />
    </View>
  );
}
