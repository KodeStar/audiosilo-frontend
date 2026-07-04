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

export function libraryHref(libraryId: number, relPath = ''): Href {
  const enc = encodePathSegments(relPath);
  return (enc ? `/library/${libraryId}/${enc}` : `/library/${libraryId}`) as Href;
}

export function bookHref(libraryId: number, relPath: string): Href {
  return `/book/${libraryId}/${encodePathSegments(relPath)}` as Href;
}

/** The full-screen player modal for a book. */
export function playerHref(libraryId: number, relPath: string): Href {
  return { pathname: '/player', params: { libraryId: String(libraryId), path: relPath } };
}
