import { forwardRef } from 'react';
import { Platform, type View } from 'react-native';

import { AnimatedPressable, type AnimatedPressableProps } from '@/components/ui/animated-pressable';
import { FOCUS_RING_CLASS, FOCUS_RING_OFFSET_CLASS } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * How a player control looks at rest: `ghost` (a glyph, a tint on press and hover: the
 * transport's round buttons, the dock's actions, the header's), `outline` (a card pill
 * with a hairline: the full player's actions and the companion chips) or `active` (the
 * brand-soft pill of a running sleep timer).
 */
export type PillLook = 'ghost' | 'outline' | 'active';

const LOOK: Record<PillLook, { base: string; web: string }> = {
  ghost: { base: 'active:bg-accent', web: `hover:bg-accent ${FOCUS_RING_CLASS}` },
  outline: {
    base: 'border border-border bg-card active:bg-accent',
    web: `hover:bg-accent ${FOCUS_RING_OFFSET_CLASS}`,
  },
  active: { base: 'border border-transparent bg-brand-soft', web: FOCUS_RING_OFFSET_CLASS },
};

/** Points per rem on iOS and Android: `polyfills.rem` in `uniwind.config.js` (the web
 * uses the browser's 16 px root). */
export const NATIVE_REM_PT = 14;

/**
 * The hit slop, on each side, that grows a control `rem` rem across (its class size:
 * `h-11` is 2.75) to the 44 pt target (STYLEGUIDE section 14) on this platform. A rem is
 * 16 px on the web but 14 pt on native, so `h-11`, 44 px on the web, is 38.5 pt on a
 * phone: the slop makes up the difference there and leaves the web as it was.
 */
export function slopTo44(rem: number): number {
  const pt = Platform.OS === 'web' ? 16 : NATIVE_REM_PT;
  return Math.max(0, Math.ceil((44 - rem * pt) / 2));
}

/**
 * The round/pill chrome every player control shares (STYLEGUIDE section 8), so the press,
 * hover and focus states come from one place: a full radius, centred content, the look's
 * fill and states. `className` sizes it (the sizes and 44 pt targets stay each caller's).
 * For a control that is not a `ControlPill` (the skip buttons).
 */
export function pillClass(look: PillLook, className?: string): string {
  return cn(
    'items-center justify-center rounded-full',
    LOOK[look].base,
    Platform.select({ web: cn('cursor-pointer', LOOK[look].web) }),
    className,
  );
}

/** A pressable player control in the shared chrome (`pillClass`): a button with its
 * label for screen readers. */
export const ControlPill = forwardRef<
  View,
  AnimatedPressableProps & { look?: PillLook; label: string }
>(function ControlPill({ look = 'ghost', label, className, ...props }, ref) {
  return (
    <AnimatedPressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={pillClass(look, className)}
      {...props}
    />
  );
});
