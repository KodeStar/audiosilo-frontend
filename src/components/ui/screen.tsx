import { View, type ViewProps } from 'react-native';

/** Full-bleed screen background matching the old client (gray-200 / gray-800). */
export function Screen({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={`flex-1 bg-gray-200 dark:bg-gray-800 ${className ?? ''}`} {...props} />;
}
