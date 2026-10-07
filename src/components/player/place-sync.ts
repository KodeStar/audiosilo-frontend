import { useTranslation } from 'react-i18next';

import { serverStatus, type ServerStatus, useReachability } from '@/api/reachability';
import { usePendingSaves } from '@/components/home/use-sync-pill';
import type { IconName } from '@/components/ui/icon';
import { useSession } from '@/stores/session';

/** Where the playing book's place is kept, as the player chrome says it. */
export type PlaceSync = 'reconnect' | 'local' | 'synced-now' | 'synced';

/**
 * Where the place lives (STYLEGUIDE section 9, "reliability shown"), truthfully: kept on
 * this device until the listener signs in again (the server refused the token, so
 * nothing replays until then); kept here while the server is unreachable or saves wait
 * in the offline queue (it replays them); else synced - "just now" while playing (the
 * store saves every 15 s), plainly once paused, which saved too. Pure.
 */
export function placeSync(status: ServerStatus, pending: number, playing: boolean): PlaceSync {
  if (status === 'reconnect') return 'reconnect';
  if (status === 'offline' || pending > 0) return 'local';
  return playing ? 'synced-now' : 'synced';
}

const ICON: Record<PlaceSync, IconName> = {
  reconnect: 'hard-drive',
  local: 'hard-drive',
  'synced-now': 'cloud',
  synced: 'cloud',
};

const TEXT = {
  reconnect: 'shell.dock.signInToSync',
  local: 'shell.dock.savedLocally',
  'synced-now': 'shell.dock.syncedNow',
  synced: 'shell.dock.synced',
} as const satisfies Record<PlaceSync, string>;

/**
 * The sync line of the playing book's server (`placeSync`), as an icon and words, for
 * the docked bar and the full player's status line. Null for a book whose server was
 * removed (a download playing on). The offline queue (this server's saves only) is read
 * as servers come and go, and polled while playing (a save refused with a 5xx is queued
 * while the server stays online), while something waits in it or a server is offline.
 */
export function usePlaceSync(
  connectionId: string,
  playing: boolean,
): { icon: IconName; text: string } | null {
  const { t } = useTranslation();
  const connection = useSession((s) => s.connections.find((c) => c.id === connectionId));
  const needsReconnect = connection?.needsReconnect;
  const status = useReachability((s) =>
    serverStatus({ id: connectionId, needsReconnect }, s.online),
  );
  const pending = usePendingSaves({ pollWhenClear: playing, connectionId });
  if (!connection) return null;
  const state = placeSync(status, pending, playing);
  return { icon: ICON[state], text: t(TEXT[state]) };
}
