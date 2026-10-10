import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type AccessibilityActionEvent, Platform, Pressable, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

/** How long a grown-up holds the button to leave kids mode. */
export const HOLD_MS = 2_000;

/**
 * "Grown-ups": press and hold for `HOLD_MS` to leave kids mode (`onExit`, which opens
 * "Who's listening?", where the PIN rules apply). A fill grows across the button while it
 * is held; letting go early empties it and nothing happens. Reduced motion: no fill, the
 * label says "Keep holding" instead, and it still takes the full 2 s (the timer, not the
 * animation, decides). A screen reader gets the hint "Hold to leave kids mode" and the
 * long-press action (VoiceOver's double-tap-and-hold also holds for real).
 */
export function GrownUpsButton({ onExit }: { onExit: () => void }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const reduced = useReducedMotion();
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fill = useSharedValue(0);
  const fillStyle = useAnimatedStyle(() => ({ width: `${fill.get() * 100}%` }));

  // A hold in progress when the screen goes away must not fire later.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
    fill.set(0);
  };

  const start = () => {
    if (timer.current) return;
    setHolding(true);
    if (!reduced) fill.set(withTiming(1, { duration: HOLD_MS, easing: Easing.linear }));
    timer.current = setTimeout(() => {
      timer.current = null;
      stop();
      onExit();
    }, HOLD_MS);
  };

  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'longpress') onExit();
  };

  return (
    <Pressable
      onPressIn={start}
      onPressOut={stop}
      accessibilityRole="button"
      accessibilityLabel={t('kids.grownUps.label')}
      accessibilityHint={t('kids.grownUps.hint')}
      accessibilityActions={[{ name: 'longpress', label: t('kids.grownUps.action') }]}
      onAccessibilityAction={onAction}
      testID="kids-grown-ups"
      className={cn(
        'min-h-16 flex-row items-center justify-center overflow-hidden rounded-full border border-border-strong bg-card px-5',
        Platform.select({ web: cn('cursor-pointer select-none', FOCUS_RING_OFFSET_CLASS) }),
      )}
    >
      {reduced ? null : (
        <Animated.View
          testID="kids-grown-ups-fill"
          pointerEvents="none"
          className="absolute bottom-0 left-0 top-0 bg-foreground/15"
          style={fillStyle}
        />
      )}
      <View className="flex-row items-center gap-2" pointerEvents="none">
        <Icon name="key" size={18} color={themed.foreground} />
        <Text className="font-sans-semibold text-base text-foreground">
          {holding ? t('kids.grownUps.holding') : t('kids.grownUps.button')}
        </Text>
      </View>
    </Pressable>
  );
}
