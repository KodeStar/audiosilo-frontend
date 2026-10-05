import { forwardRef } from 'react';
import { Platform, View, type ViewProps } from 'react-native';

import { cn } from '@/lib/utils';

import { AnimatedPressable, type AnimatedPressableProps } from './animated-pressable';

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
export const PressableRow = forwardRef<View, AnimatedPressableProps>(function PressableRow(
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
          web: 'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring',
        }),
        className,
      )}
      {...props}
    />
  );
});
