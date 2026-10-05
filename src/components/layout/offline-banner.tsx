import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { anyOffline, useReachability } from '@/api/reachability';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/theme/use-theme-colors';

function Bar({ label }: { label: string }) {
  const themed = useThemeColors();
  return (
    <View className="flex-row items-center justify-center gap-2 border-b border-border bg-muted py-1.5">
      <Icon name="offline" size={12} color={themed.mutedForeground} />
      <Text variant="caption">{label}</Text>
    </View>
  );
}

/**
 * Thin bar shown while a server is unreachable (offline, or a LAN-only server you've
 * walked away from). Playback of downloaded books carries on; progress is saved locally
 * and syncs automatically when the server comes back.
 *
 * Reachability is per-connection, so the message depends on the page it heads:
 *  - a connection-scoped page (a content route carrying `?connection=<cid>`, passed as
 *    `connectionId`): *that* server's own state;
 *  - an aggregated page (Home/Search/Libraries): a muted "some servers offline" when ANY
 *    connection is down (it can't point at one server).
 *
 * The caller passes the page's connection (each phone header its own route's param; the
 * wide shell the focused page's), so a banner subscribes to no route state, and it
 * selects only which message shows, re-rendering when that changes.
 */
export function OfflineBanner({ connectionId }: { connectionId?: string }) {
  const { t } = useTranslation();
  const message = useReachability((s) => {
    if (connectionId) return s.online[connectionId] === false ? 'scoped' : null;
    return anyOffline(s.online) ? 'some' : null;
  });
  if (message === 'scoped') return <Bar label={t('nav.offline')} />;
  return message === 'some' ? <Bar label={t('nav.someOffline')} /> : null;
}
