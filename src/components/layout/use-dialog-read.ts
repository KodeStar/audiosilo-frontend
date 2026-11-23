import { useDeviceOnline } from '@/lib/device-online';
import { useUnreadQuery } from '@/lib/offline-state';

/** A dialog can show a kept answer offline, but its server actions still need a connection. */
export function useDialogRead(query: Parameters<typeof useUnreadQuery>[0]) {
  const online = useDeviceOnline();
  return { unread: useUnreadQuery(query), offline: !online || query.isPaused };
}
