import { forwardRef, type ReactNode } from 'react';
import { Platform, View, type ViewProps, type ViewInstance } from 'react-native';

import { FOCUS_RING_CLASS } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { AnimatedPressable, type AnimatedPressableProps } from './animated-pressable';
import { Icon } from './icon';

/**
 * The quiet list-row surface (STYLEGUIDE.md section 5: chrome is flat with a 1px
 * hairline - no shadow): a `card` fill, a `border` hairline and radius 12. One place for
 * the class string that the library, downloads, account and book screens used to copy.
 * Layout (flex direction, padding, gaps) stays with the caller via `className`.
 */
const SURFACE = 'rounded-xl border border-border bg-card';

/** A static row on the quiet surface (a bookmark, a note, a skeleton row). */
export function RowSurface({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn(SURFACE, className)} {...props} />;
}

/**
 * A tappable row on the quiet surface, with the pressed (and, on web, hover) state on
 * the `accent` fill plus AnimatedPressable's press feedback. Forwards its ref, so it can
 * sit under an expo-router `<Link asChild>`.
 */
export const PressableRow = forwardRef<ViewInstance, AnimatedPressableProps>(function PressableRow(
  { className, ...props },
  ref,
) {
  return (
    <AnimatedPressable
      ref={ref}
      className={cn(
        SURFACE,
        'active:bg-accent hover:bg-accent',
        Platform.select({
          web: `cursor-pointer ${FOCUS_RING_CLASS}`,
        }),
        className,
      )}
      {...props}
    />
  );
});

/**
 * A tappable row inside a card's list (the book page's Other versions and Other recordings):
 * no surface of its own, a 48 px target with the `accent` fill when pressed (and, on web,
 * hovered), the caller's content, then a chevron. Wrapped in a list item (a list holds items).
 */
export function InsetRow({
  className,
  children,
  ...props
}: Omit<AnimatedPressableProps, 'children'> & { children: ReactNode }) {
  const themed = useThemeColors();
  return (
    <View role="listitem">
      <AnimatedPressable
        accessibilityRole="button"
        className={cn(
          'min-h-[48px] flex-row items-center gap-3 rounded-control px-2 py-2 active:bg-accent',
          Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
          className,
        )}
        {...props}
      >
        {children}
        <Icon name="chevron-right" size={14} color={themed.mutedForeground} />
      </AnimatedPressable>
    </View>
  );
}
