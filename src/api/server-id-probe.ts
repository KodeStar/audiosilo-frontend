import type { ServerIdProbe } from '@/lib/server-address';

import { ApiClient } from './client';

/** How long the home address gets to answer before the player uses the away one. */
export const PROBE_TIMEOUT_MS = 2_500;

/** Ask `url` who it is: `GET <url>/api/v1/server` with NO token (a bare client: no
 * Authorization header, no reconnect callback). The `server_id` it answered, or null.
 * The address runner probes a connection's home address with it; the connect screen a
 * remembered server's. */
export const probeServerId: ServerIdProbe = async (url) => {
  try {
    const info = await new ApiClient(url, null, PROBE_TIMEOUT_MS).serverInfo();
    return typeof info?.server_id === 'string' ? info.server_id : null;
  } catch {
    return null;
  }
};
