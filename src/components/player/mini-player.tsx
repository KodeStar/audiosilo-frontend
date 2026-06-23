import { BlurView } from 'expo-blur';
import { router } from 'expo-router';
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { useApi } from '@/api/provider';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { selectIsPlaying, usePlayer } from '@/playback/store';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

const NATIVE_BLUR = Platform.OS !== 'web';

// Matches the AppShell breakpoint: at/above this the player is a docked side
// panel, not a floating bar, so screens need no extra bottom padding.
const WIDE_BREAKPOINT = 1024;

/** Approximate rendered height of the docked bar (cover 40 + py-2 + borders). */
export const MINI_PLAYER_HEIGHT = 60;
/** Gap kept between the floating bar and the nav below it. */
export const MINI_PLAYER_GAP = 8;
/** The base bottom padding the scroll screens already carry (their `p-4`). */
const BASE_CONTENT_PADDING = 16;

/**
 * Bottom padding a scrollable phone screen should give its scroll content so the
 * last row clears the floating mini-player. The bar is absolutely positioned and
 * content scrolls *behind* it, so without this the final items sit underneath it.
 * Returns just the normal base padding when nothing is docked, or on wide layouts
 * where the player is a side panel rather than a floating bar.
 */
export function useMiniPlayerInset(): number {
  const docked = usePlayer((s) => s.nowPlaying != null);
  const { width } = useWindowDimensions();
  const floating = docked && width < WIDE_BREAKPOINT;
  return BASE_CONTENT_PADDING + (floating ? MINI_PLAYER_HEIGHT + MINI_PLAYER_GAP : 0);
}

/** Docked transport bar shown whenever something is loaded. Tap to open the full
 * player. It floats just above the bottom nav — `bottomOffset` is the nav's
 * measured height (which on iOS includes the home-indicator safe-area inset, so a
 * fixed offset would leave the bar hidden behind it). Content scrolls behind it;
 * screens reserve room with `useMiniPlayerInset()`. */
export function MiniPlayer({ bottomOffset = 0 }: { bottomOffset?: number }) {
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const isPlaying = usePlayer(selectIsPlaying);
  const toggle = usePlayer((s) => s.toggle);
  const api = useApi();
  const { scheme } = useTheme();

  if (!nowPlaying) return null;

  // The translucency that lets the blur show through differs by platform: on
  // native a real BlurView sits behind a light tint; on web `backdrop-blur-sm`
  // (a CSS backdrop-filter, native-ignored) blurs behind a denser `/90` fill.
  const fill = NATIVE_BLUR
    ? 'bg-gray-50/60 dark:bg-gray-840/60'
    : 'bg-gray-50/90 dark:bg-gray-840/90';

  return (
    <Pressable
      onPress={() => router.push('/player')}
      style={{ bottom: bottomOffset + MINI_PLAYER_GAP }}
      className="absolute inset-x-2 overflow-hidden rounded-lg border border-gray-100 dark:border-gray-750"
    >
      {NATIVE_BLUR ? (
        <BlurView
          intensity={40}
          tint={scheme === 'dark' ? 'dark' : 'light'}
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View className={`flex-row items-center gap-3 px-3 py-2 backdrop-blur-sm ${fill}`}>
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
      </View>
    </Pressable>
  );
}
