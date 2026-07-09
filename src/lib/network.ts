import { Platform } from 'react-native';
import * as Network from 'expo-network';

import type { AutoDownloadMode } from '@/stores/settings';

/**
 * Whether an auto-download is allowed under the user's `autoDownloadNext` preference,
 * given the current network. `'never'`/`'always'` are absolute; `'wifi'` allows only an
 * unmetered connection (Wi-Fi or Ethernet).
 *
 * The probe fails open: browsers can't reliably report the connection type and a desktop
 * is almost never metered, so `UNKNOWN`/undefined type, web, and any probe error all
 * allow the download - a failed probe should never block a wifi user. Only a type we
 * positively know is metered/none (cellular, no connection, ...) denies.
 */
export async function canAutoDownload(mode: AutoDownloadMode): Promise<boolean> {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  // mode === 'wifi'
  if (Platform.OS === 'web') return true; // the browser can't tell us; assume unmetered
  try {
    const state = await Network.getNetworkStateAsync();
    const type = state.type;
    if (type === undefined || type === Network.NetworkStateType.UNKNOWN) return true;
    return type === Network.NetworkStateType.WIFI || type === Network.NetworkStateType.ETHERNET;
  } catch {
    return true; // fail open: a failed probe shouldn't strand a user on wifi
  }
}
