import { View, type ViewProps } from 'react-native';

/** Rounded surface: drop shadow in light mode, bordered in dark (per old client). */
export function Card({ className, ...props }: ViewProps & { className?: string }) {
  return (
    <View
      className={`rounded-lg bg-white p-4 shadow-sm dark:border dark:border-gray-860 dark:bg-gray-840 dark:shadow-none ${className ?? ''}`}
      {...props}
    />
  );
}
