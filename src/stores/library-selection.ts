import { create } from 'zustand';

import { persistedDocument } from '@/lib/storage';
import { onConnectionRemoved } from '@/stores/session';

/** The library the Library tab's browse modes act on: one library on one server. */
export type LibrarySelection = { connectionId: string; libraryId: number };

type Doc = { selection: LibrarySelection | null };

function parseSelection(raw: unknown): LibrarySelection | null {
  if (!raw || typeof raw !== 'object') return null;
  const { connectionId, libraryId } = raw as Record<string, unknown>;
  return typeof connectionId === 'string' &&
    connectionId &&
    typeof libraryId === 'number' &&
    Number.isSafeInteger(libraryId) &&
    libraryId > 0
    ? { connectionId, libraryId }
    : null;
}

function parseDoc(raw: unknown): Partial<Doc> {
  if (!raw || typeof raw !== 'object' || !('selection' in raw)) return {};
  return { selection: parseSelection((raw as { selection: unknown }).selection) };
}

// Device-local, connection-scoped: a removed connection's pick is dropped below. Not in
// session.ts's SCOPED_STORAGE_KEYS: a stale pick is harmless (it resolves to the first
// library, `resolveLibrarySelection`), so neither storage-reset axis needs to wipe it.
const stored = persistedDocument<Doc>('audiosilo.librarySelection', parseDoc);

type LibrarySelectionState = Doc & {
  hydrate: () => Promise<void>;
  /** Remember the library the browse modes show. */
  select: (selection: LibrarySelection) => void;
  /** Forget the pick (the browse modes fall back to the first library). */
  clear: () => void;
};

/**
 * The user's chosen library for the Library tab's browse modes, persisted on the device
 * (`persistedDocument`: a pick made before hydration wins). Hydrated once at boot from
 * `_layout.tsx`. Read it through `useSelectedLibrary()`, which reconciles it against the
 * libraries the servers list now.
 */
export const useLibrarySelection = create<LibrarySelectionState>()((set, get) => ({
  selection: null,
  hydrate: () => stored.hydrate({ selection: null }, (doc) => set(doc)),
  select: (selection) => {
    const cur = get().selection;
    if (cur?.connectionId === selection.connectionId && cur.libraryId === selection.libraryId) {
      return;
    }
    set({ selection });
    stored.write({ selection }, { selection });
  },
  clear: () => {
    if (!get().selection) return;
    set({ selection: null });
    stored.write({ selection: null }, { selection: null });
  },
}));

// A removed connection's pick would point at a server that is gone for good (re-adding
// it mints a new id): drop it with the rest of its scoped state.
onConnectionRemoved((id) => {
  if (useLibrarySelection.getState().selection?.connectionId === id) {
    useLibrarySelection.getState().clear();
  }
});

/** One connection's libraries as the picker and the resolution see them. */
export type LibraryGroup = {
  connectionId: string;
  connectionName: string;
  /** Its libraries, in the server's order (empty while loading or on an error). */
  libraryIds: number[];
  /** `ready` once the list has loaded; `loading` before; `error` when it failed (an
   * offline server), which says nothing about whether a library still exists. */
  status: 'loading' | 'ready' | 'error';
};

/**
 * The library the browse modes show: the stored pick while it still exists, else the
 * first library of the first connection that has one. A pick is kept while its server's
 * list is loading or failing (offline is not "gone"); it is replaced only once its
 * connection is gone or its server's loaded list lacks it. The fallback walks the
 * connections in order and waits (null) at one still loading, so the pick doesn't jump
 * from a later server to an earlier one as the lists arrive. Null when there is nothing
 * to show (yet).
 */
export function resolveLibrarySelection(
  stored: LibrarySelection | null,
  groups: readonly LibraryGroup[],
): LibrarySelection | null {
  if (stored) {
    const group = groups.find((g) => g.connectionId === stored.connectionId);
    if (group && (group.status !== 'ready' || group.libraryIds.includes(stored.libraryId))) {
      return stored;
    }
  }
  for (const g of groups) {
    if (g.libraryIds.length > 0)
      return { connectionId: g.connectionId, libraryId: g.libraryIds[0] };
    if (g.status === 'loading') return null;
  }
  return null;
}
