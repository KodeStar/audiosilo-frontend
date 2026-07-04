import { useGlobalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { anyOffline, useReachability } from '@/api/reachability';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { colors } from '@/theme/tokens';

function Bar({ label }: { label: string }) {
  return (
    <View className="flex-row items-center justify-center gap-2 bg-gray-300 py-1.5 dark:bg-gray-840">
      <Icon name="offline" size={13} color={colors.dark.textMuted} />
      <Text variant="caption">{label}</Text>
    </View>
  );
}

/**
 * Thin bar shown while a server is unreachable (offline, or a LAN-only server you've
 * walked away from). Playback of downloaded books carries on; progress is saved locally
 * and syncs automatically when the server comes back.
 *
 * Reachability is per-connection, so the message depends on where you are:
 *  - on a connection-scoped screen (a content route carrying `?connection=<cid>`): shows
 *    *that* server's own state;
 *  - on an aggregated screen (Home/Search/Libraries): a muted "some servers offline"
 *    when ANY connection is down (it can't point at one server).
 */
export function OfflineBanner() {
  const { t } = useTranslation();
  const online = useReachability((s) => s.online);
  const { connection } = useGlobalSearchParams<{ connection?: string | string[] }>();
  const scopeCid = Array.isArray(connection) ? (connection[0] ?? '') : (connection ?? '');

  if (scopeCid) {
    const reachable = online[scopeCid] ?? true;
    return reachable ? null : <Bar label={t('nav.offline')} />;
  }
  return anyOffline(online) ? <Bar label={t('nav.someOffline')} /> : null;
}
