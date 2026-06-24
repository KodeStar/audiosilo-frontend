import { useState } from 'react';
import { Pressable, View } from 'react-native';

/** Tap-to-seek progress bar over the given position/duration. */
export function SeekBar({
  position,
  duration,
  onSeek,
}: {
  position: number;
  duration: number;
  onSeek: (position: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const fraction = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;

  return (
    <Pressable
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onPress={(e) => {
        if (width > 0 && duration > 0) {
          onSeek(Math.max(0, Math.min(1, e.nativeEvent.locationX / width)) * duration);
        }
      }}
      className="h-6 justify-center"
    >
      <View className="h-1.5 overflow-hidden rounded-full bg-gray-400 dark:bg-gray-700">
        <View className="h-full rounded-full bg-primary" style={{ width: `${fraction * 100}%` }} />
      </View>
    </Pressable>
  );
}
