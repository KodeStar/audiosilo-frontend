import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { useApi } from '@/api/provider';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { selectIsPlaying, usePlayer } from '@/playback/store';
import { colors } from '@/theme/tokens';

/** Docked transport bar shown whenever something is loaded. Tap to open the
 * full player. */
export function MiniPlayer() {
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const isPlaying = usePlayer(selectIsPlaying);
  const toggle = usePlayer((s) => s.toggle);
  const api = useApi();

  if (!nowPlaying) return null;

  return (
    <Pressable
      onPress={() => router.push('/player')}
      className="flex-row items-center gap-3 border-t border-gray-100 bg-gray-50 px-3 py-2 dark:border-gray-750 dark:bg-gray-840"
    >
      <View className="h-10 w-10">
        <Cover
          source={{ uri: nowPlaying.cover, headers: api.authHeaders() }}
          label={nowPlaying.title}
          rounded="rounded-md"
          size={40}
        />
      </View>
      <View className="flex-1">
        <Text variant="subtitle" numberOfLines={1}>
          {nowPlaying.title}
        </Text>
        {nowPlaying.author ? (
          <Text variant="caption" numberOfLines={1}>
            {nowPlaying.author}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={() => void toggle()}
        hitSlop={12}
        className="h-10 w-10 items-center justify-center"
      >
        <Icon name={isPlaying ? 'pause' : 'play'} size={22} color={colors.primary} />
      </Pressable>
    </Pressable>
  );
}
