import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useSession } from '@/stores/session';
import { colors } from '@/theme/tokens';

/**
 * Slim, accent-bordered bar shown when a connection's token is being rejected (or its
 * server was reset), so the user is never silently stuck on dead requests. Tapping it
 * starts the reconnect flow for that server: it pre-fills the server URL via
 * `pendingServerUrl` and routes into the EXISTING connect → sign-in screens, where the
 * user just re-enters a code or password. A successful re-pair calls `setSession`, which
 * clears the flag (and refreshes the known-servers list).
 *
 * When more than one connection needs reconnecting we surface the first (with a "+N"),
 * keeping the chrome unobtrusive.
 */
export function ReconnectBanner() {
  const { t } = useTranslation();
  const connections = useSession((s) => s.connections);
  const setPendingServerUrl = useSession((s) => s.setPendingServerUrl);
  const needing = connections.filter((c) => c.needsReconnect);

  if (needing.length === 0) return null;
  const conn = needing[0];
  const extra = needing.length - 1;

  const label =
    conn.needsReconnect === 'server-reset'
      ? t('reconnect.banner.serverReset', { name: conn.name })
      : t('reconnect.banner.auth', { name: conn.name });

  const onPress = async () => {
    await setPendingServerUrl(conn.serverUrl);
    router.push({ pathname: '/connect/sign-in', params: { serverName: conn.name } });
  };

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className="flex-row items-center gap-2 border-b border-l-4 border-b-gray-200 border-l-primary bg-primary/10 px-3 py-2 active:opacity-80 dark:border-b-gray-750"
    >
      <Icon name="server" size={13} color={colors.primary} />
      <Text variant="caption" className="flex-1 text-primary">
        {label}
        {extra > 0 ? ` ${t('reconnect.banner.more', { count: extra })}` : ''}
      </Text>
      <Icon name="chevron-right" size={13} color={colors.primary} />
    </Pressable>
  );
}
