import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useReachability } from '@/api/reachability';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useDeviceOnline } from '@/lib/device-online';
import { useSession } from '@/stores/session';
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

/** What the bar says (CONNECT-15): with no network on the device, that it is offline;
 * with one, the server that isn't answering, by name, when there is one ("Hearthside
 * isn't answering"), else that some servers are offline. `down` are the names of the
 * servers the bar is about that are not answering; null: no bar. Pure, so it is tested
 * without the stores. */
export function offlineBannerText(
  down: readonly string[],
  deviceOnline: boolean,
  t: TFunction,
): string | null {
  if (down.length === 0) return null;
  if (!deviceOnline) return t('nav.offline');
  if (down.length === 1) return t('shell.notAnswering', { name: down[0] });
  return t('nav.someOffline');
}

/**
 * Thin bar shown while a server is unreachable (offline, or a LAN-only server you've
 * walked away from). Playback of downloaded books carries on; progress is saved locally
 * and syncs automatically when the server comes back.
 *
 * Reachability is per-connection, so the message depends on the page it heads:
 *  - a connection-scoped page (a content route carrying `?connection=<cid>`, passed as
 *    `connectionId`): *that* server's own state;
 *  - an aggregated page (Home/Search/Libraries): any of the listener's servers that is
 *    down, by name when it is one (`offlineBannerText`).
 *
 * The caller passes the page's connection (each phone header its own route's param; the
 * wide shell the focused page's), so a banner subscribes to no route state, and it
 * selects only which servers are down, re-rendering when that changes.
 */
export function OfflineBanner({ connectionId }: { connectionId?: string }) {
  const { t } = useTranslation();
  const deviceOnline = useDeviceOnline();
  // The ids of the servers this bar is about that are down, one string so a re-render
  // follows only a change in them.
  const downIds = useReachability((s) =>
    connectionId
      ? s.online[connectionId] === false
        ? connectionId
        : ''
      : Object.keys(s.online)
          .filter((id) => s.online[id] === false)
          .join('\n'),
  );
  const connections = useSession((s) => s.connections);
  const ids = downIds ? downIds.split('\n') : [];
  const down = connections.filter((c) => ids.includes(c.id)).map((c) => c.name);
  // A scoped page's server this device has no name for still says it is offline.
  const label =
    connectionId && ids.length > 0 && down.length === 0
      ? t('nav.offline')
      : offlineBannerText(down, deviceOnline, t);
  return label ? <Bar label={label} /> : null;
}
