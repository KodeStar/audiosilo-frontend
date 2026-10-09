import { useHousehold, useHouseListening } from '@/api/hooks';
import type { HouseListeningRow } from '@/api/types';

import { visibleRows } from './house-model';

/**
 * What the other people on one server who share are listening to, for a surface that is
 * on screen (`active`). Nothing is asked of a server without `household` (the hooks gate
 * on it), and the house itself is only polled while the caller shares and the surface is
 * active: most listeners never turn sharing on, and a Home kept mounted under another tab
 * must not ask every minute. Loading, an error and "not sharing" all read as no rows: the
 * house is an extra, never an empty section or an error banner.
 */
export function useHouseRows(connectionId: string, active: boolean): HouseListeningRow[] {
  const settings = useHousehold(connectionId);
  const sharing = settings.data?.share_listening === true;
  const house = useHouseListening(connectionId, { enabled: active && sharing });
  return visibleRows(house.data, sharing);
}
