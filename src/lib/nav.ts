/**
 * Tab-bar active-route matching, extracted from the nav bar so the route logic is
 * unit-testable (and not buried in a component). A tab matches its own path —
 * exactly, or as an ancestor segment of the current route — plus any `alsoMatch`
 * paths for related routes that live outside it (e.g. a book screen is reached
 * through the library tab, so `/book/...` keeps Library highlighted).
 */
export function matchesPath(pathname: string, match: string): boolean {
  return match === '/' ? pathname === '/' : pathname === match || pathname.startsWith(`${match}/`);
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
