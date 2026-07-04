/**
 * Tab-bar active-route matching, extracted from the nav bar so the route logic is
 * unit-testable (and not buried in a component). A tab matches its own path -
 * exactly, or as an ancestor segment of the current route - plus any `alsoMatch`
 * paths for related routes that live outside it (e.g. a book screen is reached
 * through the library tab, so `/book/...` keeps Library highlighted).
 */
export function matchesPath(pathname: string, match: string): boolean {
  return match === '/' ? pathname === '/' : pathname === match || pathname.startsWith(`${match}/`);
}

/**
 * Strip a leading connection scope (`/s/<connectionId>`) so tab-active matching and
 * section detection operate on the logical content path regardless of which server's
 * scope it sits under: `/s/abc/library/5` → `/library/5`, `/s/abc` → `/`. Unscoped
 * paths (`/`, `/settings`, `/library`) pass through unchanged.
 */
export function contentPath(pathname: string): string {
  const m = pathname.match(/^\/s\/[^/]+(\/.*)?$/);
  return m ? (m[1] ?? '/') : pathname;
}

/** The connection id a scoped content path is under (`/s/<connectionId>/…`), or '' when
 * the path isn't connection-scoped (Home, Search, Settings, aggregated Library). Lets
 * chrome above the route scope (e.g. the offline banner) tell which server, if any, the
 * current screen belongs to. */
export function scopeConnectionId(pathname: string): string {
  const m = pathname.match(/^\/s\/([^/]+)/);
  return m ? m[1] : '';
}

export function isActiveNav(
  pathname: string,
  item: { match: string; alsoMatch?: string[] },
): boolean {
  return (
    matchesPath(pathname, item.match) ||
    (item.alsoMatch?.some((m) => matchesPath(pathname, m)) ?? false)
  );
}
