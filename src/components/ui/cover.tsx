import { Image, type ImageSource } from 'expo-image';
import { useState } from 'react';
import { View } from 'react-native';

import { clothColor, titleMonogram } from '@/lib/monogram';

import { Text } from './text';

/** Below this size (points) a cover has no room for its title: it shows a monogram. */
export const MONOGRAM_MAX_SIZE = 72;

/**
 * 1:1 cover art with a graceful fallback. When there is no source - or the image
 * fails to load (e.g. the book has no embedded art and no folder cover, so the
 * cover endpoint 404s) - it shows the book's title and author instead of a blank
 * square. A cover drawn smaller than `MONOGRAM_MAX_SIZE` (a queue thumb, the dock)
 * can't fit a title, which overflowed as clipped fragments ("d Rites Jim"), so it
 * shows the title's initials on the title's own cloth colour instead. `source`
 * accepts an authenticated expo-image source (uri + headers).
 */
export function Cover({
  source,
  label,
  sublabel,
  rounded = 'rounded-lg',
  size,
  onError,
}: {
  source?: ImageSource | string | null;
  label?: string;
  sublabel?: string;
  rounded?: string;
  size?: number;
  /** Called when the image fails to load (after the fallback takes over), so a caller
   * can try another source (a thumbnail falling back to the full art). */
  onError?: () => void;
}) {
  // Track which source URI failed (rather than a bare boolean) so the error state
  // resets automatically when the source changes - list rows recycle covers.
  const [failedKey, setFailedKey] = useState<string | undefined>(undefined);
  const key = typeof source === 'string' ? source : source?.uri;
  const failed = key !== undefined && failedKey === key;

  return (
    <View
      className={`aspect-square w-full overflow-hidden bg-muted ${rounded}`}
      style={size ? { width: size, height: size } : undefined}
    >
      {source && !failed ? (
        <Image
          source={source}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={150}
          recyclingKey={key}
          onError={() => {
            setFailedKey(key);
            onError?.();
          }}
        />
      ) : size !== undefined && size < MONOGRAM_MAX_SIZE ? (
        label ? (
          <View
            testID="cover-monogram"
            aria-hidden
            className="flex-1 items-center justify-center"
            style={{ backgroundColor: clothColor(label) }}
          >
            <Text
              className="font-display text-white"
              style={{ fontSize: Math.round(size * 0.36), lineHeight: Math.round(size * 0.44) }}
              numberOfLines={1}
            >
              {titleMonogram(label)}
            </Text>
          </View>
        ) : null
      ) : (
        <View className="flex-1 items-center justify-center gap-0.5 p-2">
          {label ? (
            <Text className="text-center font-sans-medium text-xs" numberOfLines={3}>
              {label}
            </Text>
          ) : null}
          {sublabel ? (
            <Text className="text-center text-[10px] text-muted-foreground" numberOfLines={2}>
              {sublabel}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}
