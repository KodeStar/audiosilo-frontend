/**
 * Native: the first screen never waits for its answers (`use-startup-queries.web.ts` is
 * the web's): a native start is not a page load, and its queries live as long as the app.
 */
export function useStartupQueries(_open: boolean): boolean {
  return true;
}
