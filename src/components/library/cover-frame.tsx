import { type ReactNode } from 'react';
import { View } from 'react-native';

import { cn } from '@/lib/utils';
import { useClippedShadow } from '@/theme/clipped-shadow';

const FRAME =
  'overflow-hidden rounded-lg border border-black/10 ios-clipped-shadow dark:border-white/10';
const FRAME_SHADOW = { xs: 'shadow-xs dark:shadow-none', lg: 'shadow-lg' } as const;

/**
 * Frames cover art so dark covers separate from dark surfaces: a hairline border on
 * both themes plus a shadow - `xs` (default) is soft and light-mode only (the house
 * "shadow light / border dark" pattern), `lg` is the hero/player cover's deeper
 * shadow in both themes. Wrap every cover in this for consistent treatment;
 * `className` adds layout (size, aspect). It also owns the iOS shadow, which a
 * clipping frame needs as an inline style (see the native-shadow notes in
 * src/global.css).
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
  const shadow = useClippedShadow(size, size === 'xs');
  return (
    <View className={cn(FRAME, FRAME_SHADOW[size], className)} style={shadow}>
      {children}
    </View>
  );
}
