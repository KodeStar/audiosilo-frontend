import type { Connection } from '@/stores/session';

/** The server's admin console (`/admin`), or one of its pages: `setup` is the console's
 * "Set up your server" flow, where an admin adds the first library. */
export function adminConsoleUrl(serverUrl: string, page: '' | 'setup' = ''): string {
  return `${serverUrl.replace(/\/+$/, '')}/admin${page ? `/${page}` : ''}`;
}

/** The first of `connections` (in order) whose signed-in user is the server's admin: the
 * one an empty library state points at its console (CONNECT-02). */
export function adminConnection(
  connections: readonly Connection[],
  ids?: readonly string[],
): Connection | undefined {
  const pool = ids ? connections.filter((c) => ids.includes(c.id)) : connections;
  return pool.find((c) => c.user?.role === 'admin');
}
