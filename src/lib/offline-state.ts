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
