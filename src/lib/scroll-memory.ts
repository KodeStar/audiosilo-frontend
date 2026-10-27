import { contentKey, isKeyOf } from '@/lib/content-key';
import { onConnectionRemoved } from '@/stores/session';

/**
 * In-memory, per-route scroll offsets so a list returns to where the user left
 * it when they navigate back to it.
 *
 * Going back up to a folder mounts a fresh browse screen: breadcrumbs and rows
 * navigate with `push`, so a parent reached that way is a new screen instance, not the
 * one kept in the stack, and React Navigation can't restore its scroll for us. We key the last offset by `(connectionId, libraryId, path)` (so two
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
  for (const key of offsets.keys()) {
    if (isKeyOf(key, id)) offsets.delete(key);
  }
});
