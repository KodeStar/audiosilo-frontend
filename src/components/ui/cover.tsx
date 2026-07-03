import { Image, type ImageSource } from 'expo-image';
import { useState } from 'react';
import { View } from 'react-native';

import { Text } from './text';

/**
 * 1:1 cover art with a graceful fallback. When there is no source - or the image
 * fails to load (e.g. the book has no embedded art and no folder cover, so the
 * cover endpoint 404s) - it shows the book's title and author instead of a blank
 * square. `source` accepts an authenticated expo-image source (uri + headers).
 */
export function Cover({
  source,
  label,
  sublabel,
  rounded = 'rounded-lg',
  size,
}: {
  source?: ImageSource | string | null;
  label?: string;
  sublabel?: string;
  rounded?: string;
  size?: number;
}) {
  // Track which source URI failed (rather than a bare boolean) so the error state
  // resets automatically when the source changes - list rows recycle covers.
  const [failedKey, setFailedKey] = useState<string | undefined>(undefined);
  const key = typeof source === 'string' ? source : source?.uri;
  const failed = key !== undefined && failedKey === key;

  return (
    <View
      className={`aspect-square w-full overflow-hidden bg-gray-300 dark:bg-gray-860 ${rounded}`}
      style={size ? { width: size, height: size } : undefined}
    >
      {source && !failed ? (
        <Image
          source={source}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={150}
          recyclingKey={key}
          onError={() => setFailedKey(key)}
        />
      ) : (
        <View className="flex-1 items-center justify-center gap-0.5 p-2">
          {label ? (
            <Text
              className="text-center text-xs font-roboto-medium text-gray-600 dark:text-gray-200"
              numberOfLines={3}
            >
              {label}
            </Text>
          ) : null}
          {sublabel ? (
            <Text className="text-center text-[10px] text-gray-500" numberOfLines={2}>
              {sublabel}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}
