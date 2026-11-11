import { ApiError } from '@/api/client';

import { useDeviceOnline } from './device-online';

/**
 * What a screen says about something it could not read from a server (a list, a place, a
 * map): the ONE offline rule, shared by Home, the Library, Folders and the read-along map
 * (fe#179). Each screen used to work it out for itself.
 * - `offline`: the device has no network. The request waits for one (`waiting`: React
 *   Query holds it, `isPaused`), or it failed and the device is offline (a reload with no
 *   network, where the request went out and failed before anything knew). The screen shows
 *   the offline state and no Retry: none can work until the network is back, and the
 *   request is asked again by itself then.
 * - `failed`: it failed with a network on the device, so it is the server's trouble (a
 *   server on the same Wi-Fi with the internet down still counts as a network:
 *   `useDeviceOnline`). The screen names the server and offers Retry.
 * - null: nothing to say (read, or still on its way).
 */
export type UnreadState = 'offline' | 'failed' | null;

export function offlineState({
  waiting,
  failed,
  deviceOnline,
}: {
  /** The request is held until the network is back (`isPaused`). */
  waiting: boolean;
  /** The request failed and nothing is there to show. */
  failed: boolean;
  /** `useDeviceOnline()`. */
  deviceOnline: boolean;
}): UnreadState {
  if (waiting || (failed && !deviceOnline)) return 'offline';
  return failed ? 'failed' : null;
}

/**
 * `offlineState` of ONE read with nothing to show, for a page or a list that reads a
 * single answer: null while it holds data (a kept answer shows whatever became of the
 * read behind it). A refusal (an `ApiError`: a 401, a 404) is the server's answer, so it is
 * `failed` whatever the network did since, and the screen's own state for it stands (sign
 * in again, not in the library). The screen asks this BEFORE its skeleton: a held query
 * stays `isPending`, and a skeleton drawn for that never ends.
 */
export function useUnreadQuery(query: {
  /** `undefined`: nothing to show. */
  data: unknown;
  isPaused: boolean;
  error: unknown;
}): UnreadState {
  const deviceOnline = useDeviceOnline();
  if (query.data !== undefined) return null;
  if (query.error instanceof ApiError) return 'failed';
  return offlineState({ waiting: query.isPaused, failed: !!query.error, deviceOnline });
}
