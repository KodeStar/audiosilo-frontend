import { type ReactNode } from 'react';
import { View } from 'react-native';

import { cn } from '@/lib/utils';
import { useClippedShadow } from '@/theme/clipped-shadow';

const FRAME =
  'overflow-hidden rounded-lg border border-black/10 ios-clipped-shadow dark:border-white/10';
/** Per size: the shadow classes, and whether they are light-mode only - the iOS inline
 * shadow (useClippedShadow) mirrors the same `dark:shadow-none`. */
const FRAME_SHADOW = {
  xs: { className: 'shadow-xs dark:shadow-none', lightOnly: true },
  lg: { className: 'shadow-lg', lightOnly: false },
} as const;

/**
 * Frames cover art so dark covers separate from dark surfaces: a hairline border on
 * both themes plus a shadow - `xs` (default) is soft and light-mode only (the house
 * "shadow light / border dark" pattern), `lg` is the hero/player cover's deeper
 * shadow in both themes. Wrap every shadowed cover in this for consistent treatment
 * (the shadowless thumbnail frames in book-meta's previous-book rows and the downloads
 * list keep their own classes). `className` adds layout (size, aspect) only: the iOS
 * shadow is an inline style (a clipping frame needs it, see the native-shadow notes in
 * src/global.css), so a shadow or overflow class passed here would not reach it.
 */
export function CoverFrame({
  size = 'xs',
  className,
  children,
}: {
  size?: 'xs' | 'lg';
  className?: string;
  children: ReactNode;
}) {
  const frameShadow = FRAME_SHADOW[size];
  const shadow = useClippedShadow(size, frameShadow.lightOnly);
  return (
    <View className={cn(FRAME, frameShadow.className, className)} style={shadow}>
      {children}
    </View>
  );
}
