import { serverIdOf } from '@/lib/connection-id';
import { hostOf } from '@/lib/pairing';

type NamedServer = {
  id: string;
  serverId?: string;
  name: string;
  serverUrl: string;
};

/** A server's name, with its address only when another saved server has the same name.
 * Several accounts on one server share its label and never create a collision. */
export function serverDisplayName(
  connection: NamedServer,
  connections: readonly NamedServer[],
): string {
  const collisions = connections.filter(
    (c) => c.name === connection.name && serverIdOf(c) !== serverIdOf(connection),
  );
  if (collisions.length === 0) return connection.name;
  const host = hostOf(connection.serverUrl);
  // Servers behind the same host can live under different paths or schemes.
  const address = collisions.some((c) => hostOf(c.serverUrl) === host)
    ? connection.serverUrl.replace(/\/+$/, '')
    : host;
  return `${connection.name} (${address})`;
}
