import type { ServerIdProbe } from '@/lib/server-address';

import { connectClient } from './connect-client';

/** How long the home address gets to answer before the player uses the away one. */
export const PROBE_TIMEOUT_MS = 2_500;

/** Ask `url` who it is: `GET <url>/api/v1/server` with NO token (a bare client: no
 * Authorization header, no reconnect callback). The `server_id` it answered, or null.
 * The address runner probes a connection's home address with it; the connect screen a
 * remembered server's. Proxy headers go along only when some were entered for `url`'s own
 * origin (`connectClient`, fe#167): a home address the proxy does not guard gets none.
 */
export const probeServerId: ServerIdProbe = async (url) => {
  try {
    const info = await connectClient(url, PROBE_TIMEOUT_MS).serverInfo();
    return typeof info?.server_id === 'string' ? info.server_id : null;
  } catch {
    return null;
  }
};
