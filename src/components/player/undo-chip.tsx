import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, Platform, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { CountdownRing } from '@/components/ui/progress-ring';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { formatClock } from '@/lib/format';
import { cn } from '@/lib/utils';
import { selectUndoFor, undoJump, UNDO_WINDOW_MS, useJumpUndo } from '@/playback/jump-undo';
import { selectBookKey, usePlayer } from '@/playback/store';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

/** Take the listener back and say so (the chip's press). Returns whether there was
 * anything to undo. */
export function undoJumpWithToast(t: (key: 'player.undo.restored') => string): boolean {
  const from = undoJump();
  if (from === null) return false;
  toast({ title: t('player.undo.restored'), description: formatClock(from) });
  return true;
}

/** Whether the Undo chip shows (a jump in the PLAYING book can still be undone): for a
 * surface that makes room for it. */
export function useUndoVisible(): boolean {
  const bookKey = usePlayer(selectBookKey);
  return useJumpUndo(selectUndoFor(bookKey)) !== null;
}

/**
 * The Undo jump chip (STYLEGUIDE section 8): an ink pill, the undo glyph, "Back to
 * 17:26:50" (where the listener was in the book) and a ring that empties over its
 * 10 seconds. Appears after any jump of more than a minute in the PLAYING book
 * (`src/playback/jump-undo.ts` detects them) and renders nothing otherwise, so a surface
 * can always mount it where the chip belongs (the full player's status line, the dock's
 * right cluster). A press goes back and toasts "Back where you were".
 */
export function UndoChip({
  className,
  onLayout,
}: {
  className?: string;
  /** Its laid-out size (the dock makes room for its measured width). */
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const bookKey = usePlayer(selectBookKey);
  const jump = useJumpUndo(selectUndoFor(bookKey));
  if (!jump) return null;

  const label = t('player.undo.label', { time: formatClock(jump.from) });
  return (
    <Animated.View
      key={jump.at}
      testID="undo-chip"
      onLayout={onLayout}
      entering={FadeIn.duration(320).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(200).reduceMotion(ReduceMotion.System)}
    >
      <AnimatedPressable
        onPress={() => undoJumpWithToast(t)}
        hitSlop={5}
        accessibilityRole="button"
        accessibilityLabel={label}
        className={cn(
          'h-[34px] flex-row items-center gap-2 self-center rounded-full bg-primary pl-3 pr-1.5 shadow-overlay',
          Platform.select({ web: `cursor-pointer ${FOCUS_RING_CLASS}` }),
          className,
        )}
      >
        {/* The undo glyph: the vendored rotate arrow, mirrored (no separate glyph). */}
        <View style={{ transform: [{ scaleX: -1 }] }}>
          <Icon name="rotate" size={14} color={themed.primaryForeground} />
        </View>
        <Text
          variant="label"
          className="text-[13px] text-primary-foreground"
          numberOfLines={1}
          style={tabularNums}
        >
          {label}
        </Text>
        {/* Empties over the chip's ten seconds. */}
        <CountdownRing
          until={jump.until}
          windowMs={UNDO_WINDOW_MS}
          size={22}
          stroke={2}
          color={themed.primaryForeground}
          trackOpacity={0.25}
        />
      </AnimatedPressable>
    </Animated.View>
  );
}
