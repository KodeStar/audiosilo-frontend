import { Image, type ImageSource } from 'expo-image';
import { View } from 'react-native';

import { Text } from './text';

/**
 * 1:1 cover art with a graceful fallback (the relative path / title), mirroring
 * the old client's `Cover` component and `.cover-container` aspect ratio.
 * `source` accepts an authenticated expo-image source (uri + headers).
 */
export function Cover({
  source,
  label,
  rounded = 'rounded-lg',
  size,
}: {
  source?: ImageSource | string | null;
  label?: string;
  rounded?: string;
  size?: number;
}) {
  return (
    <View
      className={`aspect-square w-full overflow-hidden bg-gray-300 dark:bg-gray-860 ${rounded}`}
      style={size ? { width: size, height: size } : undefined}
    >
      {source ? (
        <Image
          source={source}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={150}
          recyclingKey={typeof source === 'string' ? source : undefined}
        />
      ) : (
        <View className="flex-1 items-center justify-center p-2">
          <Text className="text-center text-xs text-gray-500" numberOfLines={3}>
            {label ?? ''}
          </Text>
        </View>
      )}
    </View>
  );
}
