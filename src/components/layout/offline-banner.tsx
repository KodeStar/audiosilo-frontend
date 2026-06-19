import { View } from 'react-native';

import { useReachability } from '@/api/reachability';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { colors } from '@/theme/tokens';

/**
 * Thin bar shown while the server is unreachable (offline, or a LAN-only server
 * you've walked away from). Playback of downloaded books carries on; progress is
 * saved locally and syncs automatically when the server comes back.
 */
export function OfflineBanner() {
  const online = useReachability((s) => s.online);
  if (online) return null;
  return (
    <View className="flex-row items-center justify-center gap-2 bg-gray-300 py-1.5 dark:bg-gray-840">
      <Icon name="offline" size={13} color={colors.dark.textMuted} />
      <Text variant="caption">Offline — changes sync when reconnected</Text>
    </View>
  );
}
