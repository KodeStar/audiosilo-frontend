import { ActivityIndicator, View } from 'react-native';

import { useThemeColors } from '@/theme/use-theme-colors';

/** An activity indicator, in the theme's brand colour unless `color` is passed. */
export function Spinner({
  size = 'small',
  center = false,
  color,
}: {
  size?: 'small' | 'large';
  center?: boolean;
  color?: string;
}) {
  const brand = useThemeColors().brand;
  const indicator = <ActivityIndicator size={size} color={color ?? brand} />;
  if (center) {
    return <View className="flex-1 items-center justify-center">{indicator}</View>;
  }
  return indicator;
}
