import { View, type ViewProps } from 'react-native';

import { cn } from '@/lib/utils';

/** Full-bleed screen background (the themed `background` token). */
export function Screen({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn('flex-1 bg-background', className)} {...props} />;
}
