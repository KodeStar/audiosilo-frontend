import type { Href } from 'expo-router';

/** Encode a slash-separated library-relative path into URL path segments. */
export function encodePathSegments(relPath: string): string {
  return relPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

/** Reconstruct a rel_path from an Expo Router catch-all param. */
export function segmentsToPath(seg?: string | string[]): string {
  if (!seg) return '';
  return (Array.isArray(seg) ? seg : [seg]).join('/');
}

/** Last path segment, for breadcrumb/title display. */
export function pathLeaf(relPath: string): string {
  const parts = relPath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Path one level up (the containing folder), or '' at the library root. */
export function parentPath(relPath: string): string {
  const parts = relPath.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

// Content routes carry the connection they belong to in the path (`/s/<cid>/…`),
// so a book/library opens on its own server without flipping a global "active"
// connection - the `s/[connectionId]` route layout publishes it to the hooks below.
export function libraryHref(connectionId: string, libraryId: number, relPath = ''): Href {
  const enc = encodePathSegments(relPath);
  const base = `/s/${connectionId}/library/${libraryId}`;
  return (enc ? `${base}/${enc}` : base) as Href;
}

export function bookHref(connectionId: string, libraryId: number, relPath: string): Href {
  return `/s/${connectionId}/book/${libraryId}/${encodePathSegments(relPath)}` as Href;
}

/** The full-screen player modal for a book. The player is a root modal (outside any
 * scope), so it carries the connection as a param. */
export function playerHref(connectionId: string, libraryId: number, relPath: string): Href {
  return {
    pathname: '/player',
    params: { connectionId, libraryId: String(libraryId), path: relPath },
  };
}
