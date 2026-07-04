import { contentKey } from '@/lib/content-key';
import { onConnectionRemoved } from '@/stores/session';

/**
 * In-memory, per-route scroll offsets so a list returns to where the user left
 * it when they navigate back to it.
 *
 * The browse view fully unmounts on every navigation - the (app) group renders a
 * single `<Slot/>` (not a kept-alive stack), and breadcrumbs/rows navigate with
 * `push`, which remounts the parent fresh - so React Navigation can't restore
 * scroll for us. We key the last offset by `(connectionId, libraryId, path)` (so two
 * servers with the same (libraryId, path) don't restore each other's offset) and
 * re-apply it on mount. Session-scoped: cleared on reload, never persisted.
 */
const offsets = new Map<string, number>();

/** Stable key for a browse location, scoped to its connection. */
export const scrollKey = contentKey;

/** Record the latest scroll offset for a location. */
export function rememberScroll(key: string, offset: number): void {
  offsets.set(key, offset);
}

/** The remembered offset for a location, or 0 if it has none. */
export function recallScroll(key: string): number {
  return offsets.get(key) ?? 0;
}

/** Forget every remembered offset - used when the user leaves the browsing
 * section entirely, so re-entering the library starts fresh at the top. */
export function clearScrollMemory(): void {
  offsets.clear();
}

// Drop a removed connection's remembered offsets (keys are `${connectionId}:...`).
onConnectionRemoved((id) => {
  const prefix = `${id}:`;
  for (const key of offsets.keys()) {
    if (key.startsWith(prefix)) offsets.delete(key);
  }
});
