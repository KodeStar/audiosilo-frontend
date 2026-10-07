import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Platform, View } from 'react-native';
import Animated, { FadeInDown, FadeOut, ReduceMotion } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import {
  FADE_SECONDS,
  GRACE_SECONDS,
  selectSleepPhase,
  useSleepTimer,
} from '@/playback/sleep-timer';
import { useSettings } from '@/stores/settings';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

const RING = 42;
const STROKE = 4;

/** The ring that empties over the window: `fraction` 1 is full, 0 empty. Decorative
 * (the title says the same in words). */
function Ring({ fraction }: { fraction: number }) {
  const themed = useThemeColors();
  const r = (RING - STROKE) / 2;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction));
  return (
    <View
      style={{ width: RING, height: RING }}
      className="items-center justify-center"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <Svg
        width={RING}
        height={RING}
        style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}
      >
        <Circle
          cx={RING / 2}
          cy={RING / 2}
          r={r}
          stroke={themed.border}
          strokeWidth={STROKE}
          fill="none"
        />
        <Circle
          cx={RING / 2}
          cy={RING / 2}
          r={r}
          stroke={themed.brand}
          strokeWidth={STROKE}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={c * (1 - f)}
        />
      </Svg>
      <Icon name="sleep" size={17} color={themed.foreground} />
    </View>
  );
}

/**
 * The sleep timer's grace card (STYLEGUIDE section 8, "Sheets" > Sleep): a floating card
 * shown in the timer's last `FADE_SECONDS` (the `ending` phase) and in the post-pause
 * `grace` window, with a ring that empties over the window, what is about to happen
 * ("Fading out in 24 s", "Stopping in 24 s" for a chapter timer, which does not fade, or
 * "Paused by the sleep timer"), how to keep going (a shake, where the listener has it on
 * and the device has a sensor) and a Keep listening button. Renders nothing otherwise.
 *
 * Floating by default: mount it as the LAST child of a full-size container (the shell
 * around the dock, the phone shell) and pass `bottom`, the distance from that container's
 * bottom edge to sit at (clear of the dock or the mini player). `inline` lays it out in
 * the flow instead: the full player puts it in its status line's place, where it can
 * never cover the transport or the actions at any width. It is not a
 * dialog: it never takes focus and blocks nothing outside its own box. It is announced
 * politely instead (a live region on Android and the web, an announcement on iOS, which
 * has no live regions) - once per phase, not once per second.
 */
export function GraceCard({
  bottom = 110,
  inline = false,
  className,
}: {
  bottom?: number;
  inline?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const phase = useSleepTimer(selectSleepPhase);
  const remaining = useSleepTimer((s) => s.remaining);
  const fades = useSleepTimer((s) => s.origin?.kind === 'duration');
  const keepListening = useSleepTimer((s) => s.keepListening);
  const shakeOn = useSettings((s) => s.shakeToExtend);
  const shake = shakeOn && Platform.OS !== 'web';
  const open = phase === 'ending' || phase === 'grace';
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
    if (!open || Platform.OS !== 'ios') return;
    AccessibilityInfo.announceForAccessibility(body);
  }, [open, body]);

  if (!open) return null;
  const windowSeconds = phase === 'grace' ? GRACE_SECONDS : FADE_SECONDS;

  const card = (
    <Animated.View
      entering={FadeInDown.duration(320).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(200).reduceMotion(ReduceMotion.System)}
      testID="sleep-grace-card"
      className="w-full max-w-[460px] flex-row items-center gap-3.5 rounded-[18px] border border-border bg-popover px-4 py-3.5 shadow-overlay"
    >
      <Ring fraction={seconds / windowSeconds} />
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
  if (inline) return <View className={cn('w-full items-center', className)}>{card}</View>;
  return (
    <View
      pointerEvents="box-none"
      style={{ bottom }}
      className={cn('absolute left-3 right-3 items-center', className)}
    >
      {card}
    </View>
  );
}

/** Whether the grace card is showing (the timer's last seconds or its grace window): the
 * full player gives it the status line's place. */
export function useGraceCardOpen(): boolean {
  return useSleepTimer((s) => {
    const phase = selectSleepPhase(s);
    return phase === 'ending' || phase === 'grace';
  });
}
