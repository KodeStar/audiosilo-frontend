import type { Href } from 'expo-router';

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

// Content routes are FLAT (`/book/[libraryId]`, `/library/[libraryId]`, `/account`); the
// connection they belong to and the library-relative path both ride as QUERY params
// (`?connection=<cid>&path=<rel>`), read back as the route scope by the `(app)` layout.
//
// Why not a `/s/[connectionId]/…` route segment (the shape the multi-server refactor first
// used)? `router.push` (React Navigation's `linkTo`) can't resolve a tap into a route
// nested under a dynamic layout segment - it lands on the scope group's first child
// (`account`). A direct URL load works (it uses `getStateFromPath`, which rebuilds the
// whole state) but an in-app push doesn't. Flat routes + a query param push correctly,
// and the `?path=` form mirrors the server's own path-identity model. Returned as the
// OBJECT form (route pattern + params) so Expo Router builds and encodes the URL.
export function libraryHref(connectionId: string, libraryId: number, relPath = ''): Href {
  return {
    pathname: '/library/[libraryId]',
    params: {
      libraryId: String(libraryId),
      connection: connectionId,
      ...(relPath ? { path: relPath } : {}),
    },
  };
}

export function bookHref(connectionId: string, libraryId: number, relPath: string): Href {
  return {
    pathname: '/book/[libraryId]',
    params: { libraryId: String(libraryId), connection: connectionId, path: relPath },
  };
}

/** A connection's per-server account screen (`/account?connection=<cid>`); the `(app)`
 * layout reads the query param as the scope so its account hooks resolve to that server. */
export function accountHref(connectionId: string): Href {
  return { pathname: '/account', params: { connection: connectionId } };
}

/** The full-screen player modal for a book. The player is a root modal (outside any
 * scope), so it carries the connection as a param. */
export function playerHref(connectionId: string, libraryId: number, relPath: string): Href {
  return {
    pathname: '/player',
    params: { connectionId, libraryId: String(libraryId), path: relPath },
  };
}
