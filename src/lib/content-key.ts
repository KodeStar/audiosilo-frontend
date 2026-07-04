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
