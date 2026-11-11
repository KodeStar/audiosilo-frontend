import { create } from 'zustand';

import { persistedDocument } from '@/lib/storage';
import { LIBRARY_SELECTION_KEY } from '@/lib/storage-keys';
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
// library, `resolveLibrary`), so neither storage-reset axis needs to wipe it.
const stored = persistedDocument<Doc>(LIBRARY_SELECTION_KEY, parseDoc);

type LibrarySelectionState = Doc & {
  /** The library the browse modes last showed, in memory only: a fallback (no pick, or
   * a pick that is gone) stays put while the app runs instead of moving to an earlier
   * server that lists a library later (`resolveLibrary`). */
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

// A removed connection's pick would point at an account that is no longer signed in: drop
// it with the rest of its scoped state.
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

/** What the browse modes are on (`resolveLibrary`). */
export type LibraryResolution = {
  /** The library to show; null when there is none (yet). */
  selection: LibrarySelection | null;
  /** With no library to show: the connection whose list the Library waits for (still
   * loading, or failed), so the screen shows THAT server's loading, error or sign-in
   * state. Null when a library shows, or when every server has answered that it shares
   * none. */
  waitingOn: string | null;
};

const first = (g: LibraryGroup): LibrarySelection => ({
  connectionId: g.connectionId,
  libraryId: g.libraryIds[0],
});

/**
 * The library the browse modes show, and never another server's in place of one that has
 * not answered (fe#142: a slow, failing or signed-out server used to hand the Library to
 * the next server's books without a word):
 * 1. the stored pick while it stands (its server lists it, or has not listed anything yet:
 *    loading, failed, offline or signed out all keep it);
 * 2. else the library already shown (`shown`) while that stands, so what is on screen
 *    stays put while the app runs;
 * 3. else, the pick being gone from a server that answered, that server's first library
 *    (the listener stays on the server they chose);
 * 4. else the first library of the first connection, in the listener's order, that has
 *    not said it shares none. While that connection's list is loading or has failed there
 *    is NO library (`waitingOn` names it): its state is shown, not a later server's books.
 *    Only a server that answered with no libraries is passed over.
 * A library on another server than the one picked is therefore only ever shown once the
 * picked server has answered without it, and the screen names the server of what it
 * shows (`LibraryPicker`).
 */
export function resolveLibrary(
  stored: LibrarySelection | null,
  groups: readonly LibraryGroup[],
  shown: LibrarySelection | null = null,
): LibraryResolution {
  if (stored && stands(stored, groups)) return { selection: stored, waitingOn: null };
  if (shown && stands(shown, groups)) return { selection: shown, waitingOn: null };
  const chosen = stored && groups.find((g) => g.connectionId === stored.connectionId);
  if (chosen && chosen.libraryIds.length > 0) return { selection: first(chosen), waitingOn: null };
  const home = groups.find((g) => g.status !== 'ready' || g.libraryIds.length > 0);
  if (!home) return { selection: null, waitingOn: null };
  if (home.status !== 'ready') return { selection: null, waitingOn: home.connectionId };
  return { selection: first(home), waitingOn: null };
}

/**
 * The car's Library tab: `resolveLibrary`'s library, except that the car never waits on a
 * server. It has no picker and no state to show for one, so waiting on the first server
 * while it can't be read (rule 4: no pick, or a pick whose server answered that it shares
 * nothing) left the tab empty for the whole drive. There the first server that IS read and
 * has a library is listed instead (the listener's own order). A pick whose server has not
 * answered, or still has a library, is never replaced by another server's (rules 1 to 3),
 * and nothing is remembered: once the first server answers, the tab is its library again.
 */
export function resolveCarLibrary(
  stored: LibrarySelection | null,
  groups: readonly LibraryGroup[],
  shown: LibrarySelection | null = null,
): LibrarySelection | null {
  const { selection, waitingOn } = resolveLibrary(stored, groups, shown);
  if (selection || !waitingOn) return selection;
  const read = groups.find((g) => g.status === 'ready' && g.libraryIds.length > 0);
  return read ? first(read) : null;
}
