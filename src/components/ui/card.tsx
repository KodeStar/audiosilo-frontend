import { View, type ViewProps } from 'react-native';

import { cn } from '@/lib/utils';

/** Rounded surface: drop shadow in light mode, bordered in dark (per old client). */
export function Card({ className, ...props }: ViewProps & { className?: string }) {
  return (
    <View
      className={cn(
        'rounded-lg bg-card p-4 shadow-xs dark:border dark:border-border dark:shadow-none',
        className,
      )}
      {...props}
    />
  );
}
