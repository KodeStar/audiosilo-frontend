/**
 * The one composite key for a piece of content scoped to the server it lives on:
 * `${connectionId}:${libraryId}:${path}`. Used to key every per-server client store
 * (downloads registry + on-disk dirs, the progress mirror/queue, browse scroll memory)
 * and their React Query entries, so two servers that both have a "library 1 / Book" can
 * never share client state. One definition so the format can't drift between stores.
 */
export function contentKey(connectionId: string, libraryId: number, path: string): string {
  return `${connectionId}:${libraryId}:${path}`;
}

/** `contentKey` of anything that names a book by where it lives. */
export function contentKeyOf(b: { connectionId: string; libraryId: number; path: string }): string {
  return contentKey(b.connectionId, b.libraryId, b.path);
}

/** The connection a `contentKey` belongs to: the text before its first `:` (a connection id
 * never contains one), or null when there is none. */
export function connectionOfKey(key: string): string | null {
  const i = key.indexOf(':');
  return i < 0 ? null : key.slice(0, i);
}

/** Whether a `contentKey` belongs to this connection. */
export function isKeyOf(key: string, connectionId: string): boolean {
  return key.startsWith(`${connectionId}:`);
}
