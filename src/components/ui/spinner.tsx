import { ActivityIndicator, View } from 'react-native';

import { colors } from '@/theme/tokens';

export function Spinner({
  size = 'small',
  center = false,
  color = colors.primary,
}: {
  size?: 'small' | 'large';
  center?: boolean;
  color?: string;
}) {
  if (center) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size={size} color={color} />
      </View>
    );
  }
  return <ActivityIndicator size={size} color={color} />;
}
