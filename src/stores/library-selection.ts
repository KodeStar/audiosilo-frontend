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
  /** The library the browse modes last showed, in memory only: a fallback (no pick, or
   * a pick that is gone) stays put while the app runs instead of moving to an earlier
   * server whose list arrives later (`resolveLibrarySelection`). */
  shown: LibrarySelection | null;
  hydrate: () => Promise<void>;
  /** Remember the library the browse modes show. */
  select: (selection: LibrarySelection) => void;
  /** Forget the pick (the browse modes fall back to the first library). */
  clear: () => void;
  /** Note what the browse modes show now (`shown`). */
  hold: (selection: LibrarySelection) => void;
};

/**
 * The user's chosen library for the Library tab's browse modes, persisted on the device
 * (`persistedDocument`: a pick made before hydration wins). Hydrated once at boot from
 * `_layout.tsx`. Read it through `useSelectedLibrary()`, which reconciles it against the
 * libraries the servers list now.
 */
export const useLibrarySelection = create<LibrarySelectionState>()((set, get) => ({
  selection: null,
  shown: null,
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
  hold: (selection) => {
    const cur = get().shown;
    if (cur?.connectionId === selection.connectionId && cur.libraryId === selection.libraryId) {
      return;
    }
    set({ shown: selection });
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

/** A pick still stands while its connection is here and its server's loaded list has
 * it; a list still loading or failing (offline is not "gone") keeps it too. */
function stands(pick: LibrarySelection, groups: readonly LibraryGroup[]): boolean {
  const group = groups.find((g) => g.connectionId === pick.connectionId);
  return !!group && (group.status !== 'ready' || group.libraryIds.includes(pick.libraryId));
}

/**
 * The library the browse modes show: the stored pick while it stands, else the one they
 * already showed (`shown`) while that stands, else the first library of the first
 * connection that has one. The fallback passes over a connection still loading: a slow
 * or unreachable first server would otherwise hold the whole Library up (no library,
 * only the modes every server has) until its request gave up. Holding `shown` keeps
 * such a fallback from jumping to that earlier server when its list does arrive. Null
 * when there is nothing to show (yet).
 */
export function resolveLibrarySelection(
  stored: LibrarySelection | null,
  groups: readonly LibraryGroup[],
  shown: LibrarySelection | null = null,
): LibrarySelection | null {
  if (stored && stands(stored, groups)) return stored;
  if (shown && stands(shown, groups)) return shown;
  const first = groups.find((g) => g.libraryIds.length > 0);
  return first ? { connectionId: first.connectionId, libraryId: first.libraryIds[0] } : null;
}
