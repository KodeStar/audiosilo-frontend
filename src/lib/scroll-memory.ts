/**
 * In-memory, per-route scroll offsets so a list returns to where the user left
 * it when they navigate back to it.
 *
 * The browse view fully unmounts on every navigation — the (app) group renders a
 * single `<Slot/>` (not a kept-alive stack), and breadcrumbs/rows navigate with
 * `push`, which remounts the parent fresh — so React Navigation can't restore
 * scroll for us. We key the last offset by `(libraryId, path)` and re-apply it on
 * mount. Session-scoped: cleared on reload, never persisted.
 */
const offsets = new Map<string, number>();

/** Stable key for a browse location. */
export function scrollKey(libraryId: number, path: string): string {
  return `${libraryId}:${path}`;
}

/** Record the latest scroll offset for a location. */
export function rememberScroll(key: string, offset: number): void {
  offsets.set(key, offset);
}

/** The remembered offset for a location, or 0 if it has none. */
export function recallScroll(key: string): number {
  return offsets.get(key) ?? 0;
}

/** Forget every remembered offset — used when the user leaves the browsing
 * section entirely, so re-entering the library starts fresh at the top. */
export function clearScrollMemory(): void {
  offsets.clear();
}
