/** djb2 hash -> short hex, to tell apart slugified paths that collide. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * A filesystem- and url-safe, collision-resistant name for a book's rel_path: the tail
 * (the most specific part, at most 40 characters) for a readable name, plus `hash(path)`,
 * which is what makes it unique. The download engines name a book's folder (native) or
 * cache prefix (web) with it, and the reader its cache folder: change it and every saved
 * download is lost.
 */
export function pathSlug(path: string): string {
  const base = path
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(-40);
  return `${base || 'book'}-${hash(path)}`;
}
